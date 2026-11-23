import type { FirebaseApp } from 'firebase/app';
import type { Auth, Persistence, User } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';
import { browserAuthSdk, firestoreSdk, loadFirestoreSdk } from '../Firebase/firebaseSdk';
import { holdJournalEdits, signOutWithoutPendingEdits } from '../Journal/journalActivity';
import { countSavedDeletions, hasPendingDeletion } from '../Journal/Deletions/deletionQueue';
import {
  eraseOfflineCache,
  hasOfflineCache,
  OfflineRemovalBlocked,
  offlineStorageUnavailable,
  pendingOfflineChanges,
} from '../Firebase/offlineCache';
import { loadRecoveryCopies } from '@/features/Journal/features/AccountJournal/utils/readingRecovery';
import { StorageLockUnavailableError, withStorageLock } from '@/utils/storageLock';

const useEmulators = process.env.NEXT_PUBLIC_FIREBASE_EMULATORS === 'true';
const config = {
  apiKey: useEmulators ? 'demo-arcana-journal' : 'AIzaSyBv7MUeAR9AKuIxtTl9Bo-OflYtye7yHZk',
  authDomain: 'arcana-journal.firebaseapp.com',
  projectId: useEmulators ? 'demo-arcana-journal' : 'arcana-journal',
  appId: '1:119895825487:web:d615c201127d7eb9e4de3a',
  messagingSenderId: '119895825487',
};
interface LoginOwner {
  uid: string;
  login?: string;
}
let signingOutOwner: LoginOwner | undefined;
let invalidatedOwner: LoginOwner | undefined;
let restoringAuth = true;
let newLogin:
  | { generation: string; user?: User; email: string; trusted: boolean; previous?: LoginOwner }
  | undefined;
let movingLogin: { owner?: LoginOwner; toShared: boolean } | undefined;
const userLogins = new WeakMap<User, LoginOwner>();
let observedLogin: { owner: LoginOwner; refreshToken: string } | undefined;
const currentLogin = (user: User): LoginOwner =>
  observedLogin?.owner.uid === user.uid && observedLogin.refreshToken === user.refreshToken
    ? observedLogin.owner
    : (userLogins.get(user) ?? { uid: user.uid });
const storageLockName = 'arcana.journal.login-storage';
const withLoginStorage = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await withStorageLock(storageLockName, operation);
  } catch (error) {
    if (error instanceof StorageLockUnavailableError)
      throw new StorageLockUnavailableError(
        'This browser cannot coordinate saved logins across tabs. Restore browser permissions and retry. Use the device’s screen lock before handing it over.',
      );
    throw error;
  }
};

// Firebase owns the credential key and the callback that reconciles its Auth
// instance with the saved user. Both belong to the primary persistence manager.
const loginPersistenceManager = () => {
  const sdk = getBrowserAuth() as Auth & {
    persistenceManager?: {
      fullUserKey: string;
      boundEventHandler: StorageListener;
      persistence: InstanceType<StorageProvider>;
    };
  };
  const manager = sdk.persistenceManager;
  if (!manager?.fullUserKey || typeof manager.boundEventHandler !== 'function')
    throw new Error('The saved login could not be identified. Please reload and retry.');
  return manager;
};
const loginOwnerFrom = (record: unknown): LoginOwner | undefined => {
  if (!record || typeof record !== 'object' || !('uid' in record) || typeof record.uid !== 'string')
    return undefined;
  const generation =
    'arcanaLogin' in record && typeof record.arcanaLogin === 'string'
      ? record.arcanaLogin
      : undefined;
  const lastLogin =
    'lastLoginAt' in record &&
    (typeof record.lastLoginAt === 'string' || typeof record.lastLoginAt === 'number')
      ? String(record.lastLoginAt)
      : undefined;
  return { uid: record.uid, login: generation ?? lastLogin };
};
const storedOwner = (storage: Storage, key: string): LoginOwner | undefined => {
  const raw = storage.getItem(key);
  if (raw === null) return undefined;
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    throw new Error('The saved login could not be identified.');
  }
  const owner = loginOwnerFrom(record);
  if (!owner) throw new Error('The saved login could not be identified.');
  return owner;
};
const sameLogin = (saved: LoginOwner | undefined, owner: LoginOwner) => {
  // Old interrupted records only identified the UID. A login made by the new
  // app always has its own generation and cannot match an old untagged retry.
  return (
    saved?.uid === owner.uid &&
    (owner.login === saved.login || (!owner.login && !saved.login?.startsWith('login-')))
  );
};
const ownsStoredLogin = (storage: Storage, key: string, owner: LoginOwner) =>
  sameLogin(storedOwner(storage, key), owner);

// The Web Storage providers remove the record synchronously in _remove.
// Check at that exact operation, including when Firebase queued it earlier.
type StorageProvider = {
  new (): {
    _addListener(key: string, listener: StorageListener): void;
    _removeListener(key: string, listener: StorageListener): void;
    _get(key: string): Promise<Record<string, unknown> | null>;
    _set(key: string, value: unknown): Promise<void>;
    _remove(key: string): Promise<void>;
  };
} & Persistence;
type StorageListener = (value: unknown) => Promise<void>;
const ownerCheckedProvider = (
  provider: Persistence,
  storage: () => Storage,
  shared = false,
): Persistence => {
  const Base = provider as StorageProvider;
  return class extends Base {
    private restoredOwner?: LoginOwner;
    private observedChanges = Promise.resolve();
    private observing = false;
    private observers = new WeakMap<StorageListener, StorageListener>();
    override _addListener(key: string, listener: StorageListener) {
      if (!shared || !key.startsWith('firebase:authUser:'))
        return super._addListener(key, listener);
      if (this.observers.has(listener)) return;
      // Firebase reads immediately but applies the result on its Auth queue.
      // Finish each notification before reading the next one, including when
      // the replacement has the same UID and the SDK could otherwise skip its queue.
      const observer: StorageListener = (value) => {
        const apply = async () => {
          // A sign-in can change the selected storage before this notification
          // is applied. Only its still-registered observer may update Auth.
          if (movingLogin) await settling;
          if (this.observers.get(listener) !== observer) return;
          this.observing = true;
          try {
            await listener(value);
          } finally {
            this.observing = false;
          }
        };
        this.observedChanges = this.observedChanges.then(apply, apply);
        return this.observedChanges;
      };
      super._addListener(key, observer);
      this.observers.set(listener, observer);
    }
    override _removeListener(key: string, listener: StorageListener) {
      const observer = this.observers.get(listener);
      this.observers.delete(listener);
      super._removeListener(key, observer ?? listener);
    }
    override async _get(key: string) {
      const value = await super._get(key);
      if (key.startsWith('firebase:authUser:')) {
        const owner = loginOwnerFrom(value);
        if (restoringAuth && !this.observing) this.restoredOwner = owner;
        const token = value?.stsTokenManager;
        if (
          owner &&
          token &&
          typeof token === 'object' &&
          'refreshToken' in token &&
          typeof token.refreshToken === 'string'
        ) {
          observedLogin = { owner, refreshToken: token.refreshToken };
        }
      }
      return value;
    }
    override _set(key: string, value: unknown) {
      if (
        !key.startsWith('firebase:authUser:') ||
        !value ||
        typeof value !== 'object' ||
        !('uid' in value) ||
        typeof value.uid !== 'string'
      )
        return super._set(key, value);
      const auth = getBrowserAuth();
      const uid = value.uid;
      // setPersistence tries to copy the outgoing user to the new store. Only
      // the newly authenticated user belongs in the chosen persistence.
      if (movingLogin?.toShared === shared) return Promise.resolve();
      const prior = restoringAuth
        ? this.restoredOwner
        : auth.currentUser?.uid === uid
          ? currentLogin(auth.currentUser)
          : undefined;
      const generation =
        newLogin?.user && newLogin.user === auth.currentUser && newLogin.user.uid === uid
          ? newLogin.generation
          : undefined;
      const save = async () => {
        const saved = storedOwner(storage(), key);
        // A background credential refresh may race a sign-out or a new login.
        // It may update only the session this Firebase instance had observed.
        if (!generation && shared && (!prior || prior.uid !== uid || !sameLogin(saved, prior)))
          return;
        const login = generation ?? (saved?.uid === uid ? saved.login : undefined);
        const next = login?.startsWith('login-') ? { ...value, arcanaLogin: login } : value;
        if (storage().getItem(key) !== JSON.stringify(next)) await super._set(key, next);
        const owner = loginOwnerFrom(next);
        if (owner && auth.currentUser?.uid === uid) {
          userLogins.set(auth.currentUser, owner);
          if (generation) observedLogin = undefined;
        }
      };
      if (!shared) return save();
      return withLoginStorage(save).catch((error) => {
        // A previously authenticated owner can still restore or refresh this
        // tab in memory when coordination is denied. A new trusted login must
        // actually publish its credential under the shared lock.
        if (
          error instanceof StorageLockUnavailableError &&
          !generation &&
          prior?.uid === uid &&
          ownsStoredLogin(storage(), key, prior)
        )
          return;
        throw error;
      });
    }
    override _remove(key: string) {
      if (!key.startsWith('firebase:authUser:')) return super._remove(key);
      const migrating = movingLogin && movingLogin.toShared !== shared;
      const invalidated = invalidatedOwner;
      invalidatedOwner = undefined;
      // An observer only mirrors a removal that already happened in storage.
      // It has no authority to erase a login published while Firebase was busy.
      const owner =
        signingOutOwner ??
        invalidated ??
        (migrating ? movingLogin?.owner : restoringAuth ? this.restoredOwner : undefined);
      // Startup also clears unused tab-only credentials after selecting a
      // trusted login. Later removals always need an initiating owner.
      if (!owner && (shared || migrating || !restoringAuth)) return Promise.resolve();
      // An empty slot needs no shared lock, including during guest startup.
      if (storage().getItem(key) === null) return Promise.resolve();
      const remove = () => {
        if (owner && !ownsStoredLogin(storage(), key, owner)) return Promise.resolve();
        return super._remove(key);
      };
      return shared ? withLoginStorage(remove) : remove();
    }
  };
};
let browserAuth: Auth | undefined;
const getBrowserAuth = (): Auth => {
  if (browserAuth) return browserAuth;
  const sdk = browserAuthSdk();
  const localLogin = ownerCheckedProvider(sdk.browserLocalPersistence, () => localStorage, true);
  const sessionLogin = ownerCheckedProvider(sdk.browserSessionPersistence, () => sessionStorage);
  const auth = sdk.initializeAuth(sdk.initializeApp(config), {
    persistence: [localLogin, sessionLogin, sdk.inMemoryPersistence],
  });
  // Firebase skips this hook for storage notifications. Bind a new generation
  // only to the user authenticated by this tab's own credential request.
  sdk.beforeAuthStateChanged(auth, async (user) => {
    if (newLogin && user?.email?.toLowerCase() === newLogin.email) {
      newLogin.user = user;
      // A failed password must never change the previous session's trust. This
      // callback runs after credential verification and before the user is saved.
      const manager = loginPersistenceManager();
      const previous = manager.persistence;
      movingLogin = { owner: newLogin.previous, toShared: newLogin.trusted };
      try {
        await sdk.setPersistence(auth, newLogin.trusted ? localLogin : sessionLogin);
      } finally {
        movingLogin = undefined;
        // setPersistence changes the SDK's store but leaves its storage listener
        // on the provider chosen at startup. A restored session has no listener
        // for trusted logins until we subscribe its new provider here.
        if (previous !== manager.persistence)
          previous._removeListener(manager.fullUserKey, manager.boundEventHandler);
        manager.persistence._addListener(manager.fullUserKey, manager.boundEventHandler);
      }
    }
    // Firebase also initiates a sign-out when the server invalidates a current
    // credential. A storage notification skips this hook and grants no removal.
    if (!user && auth.currentUser && !signingOutOwner)
      invalidatedOwner = currentLogin(auth.currentUser);
  });
  void auth.authStateReady().then(() => {
    restoringAuth = false;
  });
  if (useEmulators)
    sdk.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  browserAuth = auth;
  return auth;
};

const memoryAuthFor = (app: FirebaseApp) => {
  const sdk = browserAuthSdk();
  const instance = sdk.initializeAuth(app, { persistence: sdk.inMemoryPersistence });
  if (useEmulators)
    sdk.connectAuthEmulator(instance, 'http://127.0.0.1:9099', { disableWarnings: true });
  return instance;
};

export interface JournalUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  signOutIncomplete?: boolean;
  offlineRemoval?: string;
}

const removalKey = (uid: string) => 'arcana.journal.offline-removal:' + uid;
interface OfflineRemovalReceipt {
  login: string;
  notice?: string;
}
const removalReceipts = new Map<string, OfflineRemovalReceipt>();
const loginGeneration = (user: User) =>
  currentLogin(user).login ?? user.metadata.lastSignInTime ?? 'legacy';
const removalReceipt = (user: User): OfflineRemovalReceipt | undefined => {
  let receipt = removalReceipts.get(user.uid);
  try {
    receipt ??= JSON.parse(sessionStorage.getItem(removalKey(user.uid)) ?? 'null');
  } catch {
    // An unreadable or old receipt requires checking this owner's cache again.
  }
  return receipt?.login === loginGeneration(user) ? receipt : undefined;
};
const recordRemoval = (user: User, notice?: string) => {
  const receipt = { login: loginGeneration(user), notice };
  removalReceipts.set(user.uid, receipt);
  try {
    sessionStorage.setItem(removalKey(user.uid), JSON.stringify(receipt));
  } catch {
    // A later reload can check the disk again. Restoration never erases a cache.
  }
};
const asAccount = (user: User | null): JournalUser | null => {
  if (!user) return null;
  const notice = !journalTrust(user.uid) && removalReceipt(user)?.notice;
  return {
    uid: user.uid,
    email: user.email,
    emailVerified: user.emailVerified,
    ...(notice ? { offlineRemoval: notice } : {}),
  };
};

const explicitTrust = new WeakMap<User, boolean>();
const journalTrust = (uid: string): boolean | undefined => {
  const owner = getBrowserAuth().currentUser;
  if (!owner || owner.uid !== uid) return undefined;
  // Auth restores both legacy and current sessions from the persistence chosen
  // at sign-in. Firebase has a public setter but no public getter. Isolate its
  // persistence-type getter here so a separate Web Storage write never decides
  // whether a shared-device session may save private readings.
  const sdk = getBrowserAuth() as Auth & { _getPersistenceType?: () => string };
  const type = sdk._getPersistenceType?.();
  if (type === 'LOCAL') return true;
  if (type === 'SESSION' || type === 'NONE') return false;
  return explicitTrust.get(owner);
};
export const isOfflineJournalEnabled = (uid: string) => journalTrust(uid) === true;

const requireAccount = (uid: string): User => {
  const user = getBrowserAuth().currentUser;
  if (!user || user.uid !== uid) throw new Error('The journal account has changed. Please retry.');
  return user;
};

const verificationRequired = 'Verify your email address to use your account journal.';
export const requireVerifiedAccount = (uid: string): User => {
  const user = requireAccount(uid);
  if (!user.emailVerified) throw new Error(verificationRequired);
  return user;
};

const lockKey = (uid: string) => 'arcana.journal.lock.' + uid;
const unlockKey = (uid: string) => 'arcana.journal.unlock.' + uid;
const lockReserveKey = (uid: string) => 'arcana.journal.lock-reserve.' + uid;
const reserveFirstLock = (uid: string) => {
  try {
    if (
      localStorage.getItem(lockKey(uid)) === null &&
      localStorage.getItem(lockReserveKey(uid)) === null
    ) {
      // This key is longer than the real key and holds the same number of bytes as
      // a UUID. Its presence has no effect on whether the journal is locked.
      localStorage.setItem(lockReserveKey(uid), '0'.repeat(36));
    }
  } catch {
    // Existing profiles may already be full. Only a successful real lock counts.
  }
};
const lockEvent = 'arcana-journal-lock-change';
interface TabUnlock {
  generation: string | null | undefined;
  unreadableOnly: boolean;
}
const tabUnlocks = new WeakMap<User, TabUnlock>();
const tabRelocks = new WeakMap<User, { previousLock: string | null | undefined }>();
const observedLocks = new WeakMap<User, string | null>();
const recordLock = (user: User, generation: string | null) => {
  observedLocks.set(user, generation);
  tabUnlocks.delete(user);
};
const notifyJournalLock = (uid: string) =>
  window.dispatchEvent(new CustomEvent(lockEvent, { detail: uid }));
// null is an unlocked journal. undefined means storage is unreadable.
const savedJournalLock = (uid: string): string | null | undefined => {
  try {
    const generation = localStorage.getItem(lockKey(uid));
    return generation !== null && generation !== localStorage.getItem(unlockKey(uid))
      ? generation
      : null;
  } catch {
    return undefined;
  }
};

export const isJournalLockedInThisTabOnly = (uid: string): boolean => {
  const user = getBrowserAuth().currentUser;
  if (user?.uid !== uid) return false;
  const relock = tabRelocks.get(user);
  if (!relock) return false;
  const saved = savedJournalLock(uid);
  if (
    typeof saved === 'string' &&
    relock.previousLock !== undefined &&
    saved !== relock.previousLock
  ) {
    // A newer shared generation supersedes this tab's relock.
    tabRelocks.delete(user);
    return false;
  }
  return true;
};

export const isJournalLocked = (uid: string): boolean => {
  const user = getBrowserAuth().currentUser;
  if (user?.uid !== uid) return true;
  if (isJournalLockedInThisTabOnly(uid)) return true;
  const generation = savedJournalLock(uid);
  if (journalTrust(uid) === undefined) return true;
  const proof = tabUnlocks.get(user);
  if (generation === undefined) {
    return !proof || proof.generation !== observedLocks.get(user);
  }
  observedLocks.set(user, generation);
  if (proof && (proof.unreadableOnly || proof.generation !== generation)) tabUnlocks.delete(user);
  return generation !== null && !tabUnlocks.has(user);
};

export const observeJournalLock = (uid: string, onChange: () => void): (() => void) => {
  const auth = getBrowserAuth();
  // The displayed journal may still belong to the previous user while the new
  // user's ID token is being verified. Invalidate its view immediately.
  const stopAccount = browserAuthSdk().onAuthStateChanged(auth, onChange);
  const onStorage = (event: StorageEvent) => {
    const user = auth.currentUser;
    if ((event.key === lockKey(uid) || event.key === null) && user?.uid === uid) {
      recordLock(user, event.newValue);
    }
    if (event.key === null || event.key === lockKey(uid) || event.key === unlockKey(uid))
      onChange();
  };
  const onLocalChange = (event: Event) => {
    if ((event as CustomEvent<string>).detail === uid) onChange();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(lockEvent, onLocalChange);
  window.addEventListener('pageshow', onChange);
  window.addEventListener('focus', onChange);
  document.addEventListener('visibilitychange', onChange);
  return () => {
    stopAccount();
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(lockEvent, onLocalChange);
    window.removeEventListener('pageshow', onChange);
    window.removeEventListener('focus', onChange);
    document.removeEventListener('visibilitychange', onChange);
  };
};

export const lockJournal = async (uid: string): Promise<void> => {
  const user = requireVerifiedAccount(uid);
  if (!isOfflineJournalEnabled(uid))
    throw new Error('Only a trusted device can lock an offline journal.');
  const generation = crypto.randomUUID();
  try {
    localStorage.removeItem(lockReserveKey(uid));
  } catch {
    // Attempt the lock itself even when this browser will not remove the reserve.
  }
  try {
    localStorage.setItem(lockKey(uid), generation);
  } catch {
    const saved = savedJournalLock(uid);
    tabRelocks.set(user, { previousLock: saved === undefined ? observedLocks.get(user) : saved });
    tabUnlocks.delete(user);
    notifyJournalLock(uid);
    return;
  }
  tabRelocks.delete(user);
  recordLock(user, generation);
  notifyJournalLock(uid);
};

// Firebase Auth persists the refreshed primary user during reauthentication. If
// the origin becomes read-only, independently verify the password with in-memory
// Auth and give this owner's journal the fresh credentials for this session.
let passwordVerifier: ReturnType<typeof memoryAuthFor> | undefined;
const cachedToken = (user: User): string | undefined =>
  (user.toJSON() as { stsTokenManager?: { accessToken?: string } }).stsTokenManager?.accessToken;
const tabCredentials = new WeakMap<
  User,
  {
    previousToken: string;
    primaryToken: string;
    previousAccess?: string;
    primaryAccess?: string;
    verified: User;
  }
>();
const journalCredentials = (owner: User): User => {
  const local = tabCredentials.get(owner);
  if (!local) return owner;
  // A sibling can re-publish the last persisted credentials after our primary
  // SDK refreshed its in-memory user but failed to save it. Keep both snapshots
  // associated with the local proof until a new primary credential arrives.
  const access = cachedToken(owner);
  if (
    (owner.refreshToken === local.previousToken && access === local.previousAccess) ||
    (owner.refreshToken === local.primaryToken && access === local.primaryAccess)
  )
    return local.verified;
  tabCredentials.delete(owner);
  return owner;
};

const verifyOwnerPassword = async (owner: User, email: string, password: string) => {
  const previousToken = owner.refreshToken;
  const previousAccess = cachedToken(owner);
  const sdk = browserAuthSdk();
  const credential = sdk.EmailAuthProvider.credential(email, password);
  try {
    await sdk.reauthenticateWithCredential(owner, credential);
    tabCredentials.delete(owner);
    return 'shared';
  } catch (error) {
    if (
      !error ||
      typeof error !== 'object' ||
      !('code' in error) ||
      error.code !== 'auth/internal-error'
    )
      throw error;
    passwordVerifier ??= memoryAuthFor(sdk.initializeApp(config, 'journal-password-check'));
    const { user: verified } = await sdk.signInWithCredential(passwordVerifier, credential);
    try {
      if (verified.uid !== owner.uid || requireAccount(owner.uid) !== owner)
        throw new Error('The journal account has changed. Please retry.');
      if (owner.emailVerified && !verified.emailVerified) throw new Error(verificationRequired);
      tabCredentials.set(owner, {
        previousToken,
        primaryToken: owner.refreshToken,
        previousAccess,
        primaryAccess: cachedToken(owner),
        verified,
      });
      return 'tab';
    } finally {
      await sdk.signOut(passwordVerifier);
    }
  }
};

export const unlockJournal = async (uid: string, password: string): Promise<void> => {
  const user = requireAccount(uid);
  if (!user.email) throw new Error('This journal needs an account email address to unlock.');
  const observed = observedLocks.get(user);
  const generation = savedJournalLock(uid);
  const relock = tabRelocks.get(user);
  if (journalTrust(uid) === undefined)
    throw new Error(
      'The original journal session could not be identified. Sign in again to continue.',
    );
  if (generation === null && !relock) return;
  const credentialScope = await verifyOwnerPassword(user, user.email, password);
  const verified = user.emailVerified && hasVerifiedCachedToken(journalCredentials(user));
  if (!verified) await notifyCheckedAccount(user);
  else if (connection?.uid === uid) await connection.refreshUser(user);
  if (requireAccount(uid) !== user)
    throw new Error('The journal account has changed. Please retry.');
  if (tabRelocks.get(user) !== relock)
    throw new Error('The journal was locked again. Enter your password to unlock it.');
  const current = savedJournalLock(uid);
  if (current === null) {
    tabRelocks.delete(user);
    notifyJournalLock(uid);
    return;
  }
  if (
    current !== generation ||
    (generation === undefined && observedLocks.get(user) !== observed)
  ) {
    throw new Error('The journal was locked again. Enter your password to unlock it.');
  }
  if (generation === undefined) {
    tabUnlocks.set(user, { generation: observed, unreadableOnly: true });
  } else {
    let shared = false;
    // A password still lets this owner return to verification in this tab.
    // Only verified credentials may release the lock for offline siblings.
    if (
      credentialScope === 'shared' &&
      user.emailVerified &&
      hasVerifiedCachedToken(journalCredentials(user))
    ) {
      try {
        localStorage.setItem(unlockKey(uid), generation);
        shared = true;
      } catch {
        // A full browser can read the lock but cannot save its acknowledgment.
      }
    }
    if (!shared) {
      // A local credential or acknowledgment is valid only for this tab and generation.
      observedLocks.set(user, generation);
      tabUnlocks.set(user, { generation, unreadableOnly: false });
    }
  }
  tabRelocks.delete(user);
  notifyJournalLock(uid);
};

// The SDK refreshes expired tokens before returning their claims, even offline.
// Use only the SDK user's last token for reopening a trusted cache offline.
// All remote access still goes through Firestore's verification of a fresh token.
const hasVerifiedCachedToken = (user: User): boolean => {
  try {
    const payload = cachedToken(user)?.split('.')[1];
    if (!payload) return false;
    const bytes = Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
      c.charCodeAt(0),
    );
    const claims = JSON.parse(new TextDecoder().decode(bytes));
    return (
      claims.sub === user.uid &&
      claims.aud === config.projectId &&
      claims.iss === 'https://securetoken.google.com/' + config.projectId &&
      claims.email_verified === true
    );
  } catch {
    return false;
  }
};

// A profile restored after following an email link can be newer than its cached ID token.
const verifyJournalToken = async (owner: User, forceRefresh = false, refreshUnverified = true) => {
  const user = journalCredentials(owner);
  let token;
  try {
    token = await user.getIdTokenResult(forceRefresh);
  } catch (error) {
    // A previously verified trusted user may reopen their cache with an expired token offline.
    // Firestore obtains a valid token before the server accepts any queued changes.
    if (
      !forceRefresh &&
      isOfflineJournalEnabled(user.uid) &&
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'auth/network-request-failed' &&
      hasVerifiedCachedToken(user)
    )
      return;
    throw error;
  }
  if (!forceRefresh && refreshUnverified && token.claims.email_verified !== true) {
    token = await user.getIdTokenResult(true);
  }
  if (token.claims.email_verified !== true) throw new Error(verificationRequired);
};

interface AccountConnection {
  uid: string;
  trusted: boolean;
  database: Promise<Firestore>;
  refreshUser: (user: User, force?: boolean) => Promise<void>;
  close: () => Promise<void>;
}
let connection: AccountConnection | undefined;
let closing: Promise<void> = Promise.resolve();
const releaseAccount = () => {
  if (!connection) return;
  const previous = connection;
  connection = undefined;
  closing = previous.close().catch(() => {});
};

const trustedAppName = (uid: string) => 'journal-' + uid + '-device';

let profileDatabase: Firestore | undefined;
const usesJournalDatabase = (owner: User) =>
  owner.emailVerified && hasVerifiedCachedToken(journalCredentials(owner));

export const profileDatabaseFor = async (uid: string): Promise<Firestore> => {
  const owner = requireAccount(uid);
  if (usesJournalDatabase(owner)) return databaseFor(uid);

  // Before verification, profile preferences use the signed-in Auth app.
  // Its memory cache is separate from every verified user's offline journal.
  const firestore = await loadFirestoreSdk();
  requireAccount(uid);
  if (!profileDatabase) {
    profileDatabase = firestore.initializeFirestore(getBrowserAuth().app, {
      localCache: firestore.memoryLocalCache(),
    });
    if (useEmulators) firestore.connectFirestoreEmulator(profileDatabase, '127.0.0.1', 8080);
  }
  return profileDatabase;
};

export const databaseFor = (uid: string): Promise<Firestore> => {
  const auth = getBrowserAuth();
  const user = requireVerifiedAccount(uid);
  const trusted = journalTrust(uid);
  if (trusted === undefined)
    throw new Error('Allow browser storage so this device can reopen your original journal.');
  if (
    connection?.uid === uid &&
    connection.trusted === trusted &&
    hasVerifiedCachedToken(journalCredentials(user))
  ) {
    const current = connection;
    return current.refreshUser(user, false).then(() => current.database);
  }
  releaseAccount();
  // A Firebase app name is part of the Firestore IndexedDB namespace. A trusted
  // journal can therefore resume offline writes without sharing cache with a different login.
  const name = trusted ? trustedAppName(uid) : 'journal-' + uid + '-session';
  const opened = closing.then(async () => {
    await verifyJournalToken(user);
    requireVerifiedAccount(uid);
    const firestore = await loadFirestoreSdk();
    const sdk = browserAuthSdk();
    requireVerifiedAccount(uid);
    const journalApp = sdk.initializeApp(config, name);
    try {
      const journalAuth = memoryAuthFor(journalApp);
      // Both Firebase apps use the same API key and project. Copy the restored
      // SDK user into this cache's in-memory Auth instance, including on offline reload.
      const credentials = journalCredentials(user);
      await sdk.updateCurrentUser(journalAuth, credentials);
      requireVerifiedAccount(uid);
      const database = firestore.initializeFirestore(journalApp, {
        localCache: trusted
          ? firestore.persistentLocalCache({ tabManager: firestore.persistentMultipleTabManager() })
          : firestore.memoryLocalCache(),
      });
      if (useEmulators) firestore.connectFirestoreEmulator(database, '127.0.0.1', 8080);
      // The named Auth instance holds its own copy of the owner's credentials. In
      // particular, a password reset invalidates that copy's earlier refresh token.
      let copiedToken: string | undefined = credentials.refreshToken;
      let credentialsReady = Promise.resolve();
      const refreshUser = (owner: User, force = true) => {
        const credentials = journalCredentials(owner);
        if (force || copiedToken !== credentials.refreshToken) {
          copiedToken = credentials.refreshToken;
          credentialsReady = sdk.updateCurrentUser(journalAuth, credentials).catch((error) => {
            copiedToken = undefined;
            throw error;
          });
        }
        return credentialsReady;
      };
      const stopCredentials = sdk.onIdTokenChanged(auth, (owner) => {
        if (owner?.uid === uid && owner.emailVerified && owner === auth.currentUser) {
          // Includes same-UID reauthentication from a sibling tab. A failed copy
          // will be retried on the next journal access.
          void refreshUser(owner).catch(() => {});
        }
      });
      return { database, journalApp, refreshUser, stopCredentials };
    } catch (error) {
      await sdk.deleteApp(journalApp);
      throw error;
    }
  });
  const next: AccountConnection = {
    uid,
    trusted,
    database: opened.then(({ database }) => database),
    refreshUser: async (owner, force = true) => {
      const current = await opened;
      if (requireVerifiedAccount(uid) !== owner)
        throw new Error('The journal account has changed. Please retry.');
      await current.refreshUser(owner, force);
    },
    close: async () => {
      const { database, journalApp, stopCredentials } = await opened;
      stopCredentials();
      try {
        await firestoreSdk().terminate(database);
      } finally {
        await browserAuthSdk().deleteApp(journalApp);
      }
    },
  };
  connection = next;
  void next.database.catch(() => {
    if (connection === next) connection = undefined;
  });
  return next.database;
};

let settling: Promise<void> = Promise.resolve();
let authBusy = false;
const withAuthChange = async (change: () => Promise<void>) => {
  if (authBusy) throw new Error('An account request is already in progress.');
  authBusy = true;
  let started = false;
  try {
    try {
      if (navigator.locks) {
        // Keep an owner's final check and removal together with respect to
        // sign-ins and sign-outs in the app's other tabs.
        await navigator.locks.request('arcana.journal.auth-change', () => {
          started = true;
          return change();
        });
        return;
      }
    } catch (error) {
      if (started) throw error;
    }
    // Restricted browsers still check ownership at the storage operation.
    await change();
  } finally {
    authBusy = false;
  }
};
const refreshListeners = new Set<(user: JournalUser | null) => void>();
const interruptedSignOutKey = 'arcana.journal.interrupted-sign-out.v1';
interface InterruptedSignOut {
  uid: string;
  trusted: boolean;
  login?: string;
}
const restoreInterruptedSignOut = (): InterruptedSignOut | null => {
  try {
    const record = JSON.parse(sessionStorage.getItem(interruptedSignOutKey) ?? 'null');
    if (record && typeof record.uid === 'string' && typeof record.trusted === 'boolean')
      return record;
  } catch {
    // The in-memory gate still protects an open tab with restricted storage.
  }
  return null;
};
let interruptedSignOut = typeof window === 'undefined' ? null : restoreInterruptedSignOut();
const setInterruptedSignOut = (record: InterruptedSignOut | null) => {
  interruptedSignOut = record;
  try {
    if (record) sessionStorage.setItem(interruptedSignOutKey, JSON.stringify(record));
    else sessionStorage.removeItem(interruptedSignOutKey);
  } catch {
    // Other tabs and a reopened app can retain their Firebase session.
  }
};
const visibleAccount = (account: JournalUser | null): JournalUser | null => {
  if (interruptedSignOut && (!account || account.uid === interruptedSignOut.uid)) {
    return {
      uid: interruptedSignOut.uid,
      email: null,
      emailVerified: false,
      signOutIncomplete: true,
    };
  }
  return account;
};
const checkedAccount = async (
  user: User | null,
  refreshUnverified = true,
): Promise<JournalUser | null> => {
  const account = asAccount(user);
  if (user?.emailVerified && account) {
    try {
      await verifyJournalToken(user, false, refreshUnverified);
      if (!user.emailVerified || !hasVerifiedCachedToken(journalCredentials(user)))
        return { ...account, emailVerified: false };
    } catch {
      return { ...account, emailVerified: false };
    }
  }
  return account;
};
const notifyCheckedAccount = async (user: User | null) => {
  const account = await checkedAccount(user);
  if (getBrowserAuth().currentUser !== user)
    throw new Error('The journal account has changed. Please retry.');
  const visible = visibleAccount(account);
  for (const listener of refreshListeners) listener(visible);
  return visible;
};
export const observeAccount = (onUser: (user: JournalUser | null) => void): (() => void) => {
  const auth = getBrowserAuth();
  let active = true;
  let revision = 0;
  let previous: User | null | undefined;
  let shown: JournalUser | null | undefined;
  const publish = (account: JournalUser | null) => {
    shown = account;
    onUser(account);
  };
  refreshListeners.add(publish);
  const unsubscribe = browserAuthSdk().onIdTokenChanged(auth, async () => {
    const version = ++revision;
    await settling;
    if (!active || version !== revision) return;
    const user = auth.currentUser;
    const changedUser = previous !== user;
    previous = user;
    // A refreshed token can withdraw verification without changing the UID or
    // cached profile. Hide an open journal before waiting for any storage I/O.
    if (
      shown?.emailVerified &&
      user &&
      shown.uid === user.uid &&
      (!user.emailVerified || !hasVerifiedCachedToken(journalCredentials(user)))
    ) {
      releaseAccount();
      publish(visibleAccount({ ...shown, emailVerified: false }));
    }
    if (user && interruptedSignOut && user.uid !== interruptedSignOut.uid) {
      try {
        const storage = interruptedSignOut.trusted ? localStorage : sessionStorage;
        if (!ownsStoredLogin(storage, loginPersistenceManager().fullUserKey, interruptedSignOut))
          setInterruptedSignOut(null);
      } catch {
        // A different session can be restored while the original store is
        // unavailable. Keep its gate until the owner's sign-out can be checked.
      }
    }
    if (interruptedSignOut) {
      publish(visibleAccount(null));
      return;
    }
    if (user) {
      if (journalTrust(user.uid)) reserveFirstLock(user.uid);
      isJournalLocked(user.uid);
    }
    if (connection && (connection.uid !== user?.uid || !user?.emailVerified)) releaseAccount();
    if (user && journalTrust(user.uid) === false) await checkRestoredSession(user);
    const account = await checkedAccount(user, changedUser);
    if (active && version === revision && auth.currentUser === user) {
      if (!account?.emailVerified && connection?.uid === user?.uid) releaseAccount();
      if (
        account?.emailVerified &&
        isOfflineJournalEnabled(account.uid) &&
        isJournalLocked(account.uid)
      ) {
        // A fresh locked tab has no reading listeners. Starting this owner's
        // Firestore client resumes its persisted writes without displaying data.
        void databaseFor(account.uid)
          .then((database) => firestoreSdk().waitForPendingWrites(database))
          .catch(() => {
            // An account switch may stop the client. Unsynced copies stay with the owner.
          });
      }
      publish(visibleAccount(account));
    }
  });
  return () => {
    active = false;
    refreshListeners.delete(publish);
    unsubscribe();
  };
};

// A memory-only journal can still open while a trusted tab finishes syncing.
// Keep a retry notice with this session until every private copy is accounted for.
const ensureRecoverySettled = async (uid: string) => {
  const inventory = loadRecoveryCopies(uid);
  if (!inventory.complete) throw new Error(offlineStorageUnavailable);
  if (inventory.copies.length || inventory.pendingCleanup.length || inventory.prepared.length)
    throw new OfflineRemovalBlocked(pendingOfflineChanges);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const pendingDeletes = await Promise.race([
    countSavedDeletions(uid),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(offlineStorageUnavailable)), 2000);
    }),
  ]).finally(() => clearTimeout(timeout));
  if (pendingDeletes) throw new OfflineRemovalBlocked(pendingOfflineChanges);
};
const removalError = (error: unknown) =>
  error instanceof OfflineRemovalBlocked ? error.message : offlineStorageUnavailable;
const restoredChecks = new WeakMap<User, Promise<void>>();
const checkRestoredSession = (user: User) => {
  if (removalReceipt(user)) return;
  const existing = restoredChecks.get(user);
  if (existing) return existing;
  const generation = loginGeneration(user);
  const check = async () => {
    let notice: string | undefined;
    try {
      await ensureRecoverySettled(user.uid);
      if (await hasOfflineCache(trustedAppName(user.uid), config.projectId)) {
        // An old session has no record of when trust was last granted. A newer
        // trusted login may already have signed out. Ask before erasing its cache.
        notice =
          'An offline journal from a trusted sign-in is still on this device. Choose Retry offline journal removal to check pending changes and remove this account’s copy.';
      }
    } catch (error) {
      notice = removalError(error);
    }
    if (
      getBrowserAuth().currentUser === user &&
      loginGeneration(user) === generation &&
      !removalReceipt(user)
    )
      recordRemoval(user, notice);
  };
  const pending = check().finally(() => restoredChecks.delete(user));
  restoredChecks.set(user, pending);
  return pending;
};
const removeOfflineJournal = async (uid: string) => {
  const user = requireAccount(uid);
  if (journalTrust(uid) !== false)
    throw new Error('Sign in with device trust off to remove the offline journal.');
  recordRemoval(user, offlineStorageUnavailable);
  try {
    if (storedOwner(localStorage, loginPersistenceManager().fullUserKey)?.uid === uid) {
      throw new OfflineRemovalBlocked(
        'This account still has a trusted sign-in on this device. Let its journal sync, sign out of the trusted tab, then retry removal here.',
      );
    }
    if (connection?.uid === uid && connection.trusted) {
      if (hasOutstandingWrites(uid)) throw new OfflineRemovalBlocked(pendingOfflineChanges);
      releaseAccount();
    }
    await closing;
    await ensureRecoverySettled(uid);
    await eraseOfflineCache(trustedAppName(uid), config.projectId);
    recordRemoval(user);
  } catch (error) {
    recordRemoval(user, removalError(error));
  }
};

export const retryOfflineRemoval = (uid: string) =>
  withAuthChange(async () => {
    await removeOfflineJournal(uid);
    await notifyCheckedAccount(requireAccount(uid));
  });

const authenticate = (email: string, password: string, trusted: boolean, register: boolean) =>
  withAuthChange(async () => {
    let finished!: () => void;
    settling = new Promise<void>((resolve) => {
      finished = resolve;
    });
    try {
      // Check before Firebase switches its in-memory user; the actual shared
      // credential write also takes the lock when it is ready to publish.
      if (trusted) await withLoginStorage(async () => {});
      const auth = getBrowserAuth();
      const current = auth.currentUser;
      newLogin = {
        generation: 'login-' + crypto.randomUUID(),
        email: email.trim().toLowerCase(),
        previous: current ? currentLogin(current) : undefined,
        trusted,
      };
      const credential = register
        ? await browserAuthSdk().createUserWithEmailAndPassword(auth, email.trim(), password)
        : await browserAuthSdk().signInWithEmailAndPassword(auth, email.trim(), password);
      explicitTrust.set(credential.user, trusted);
      if (trusted) reserveFirstLock(credential.user.uid);
      else if (!register) await removeOfflineJournal(credential.user.uid);
      else recordRemoval(credential.user);
      if (savedJournalLock(credential.user.uid) === undefined) {
        tabUnlocks.set(credential.user, {
          generation: observedLocks.get(credential.user),
          unreadableOnly: true,
        });
      }
    } finally {
      newLogin = undefined;
      finished();
    }
  });

const returnToJournal = () => ({ url: new URL('/journal', window.location.origin).href });
export const signIn = (email: string, password: string, trusted = false) =>
  authenticate(email, password, trusted, false);
export const signUp = async (email: string, password: string, trusted = false) => {
  await authenticate(email, password, trusted, true);
  await sendVerification();
};
export const sendVerification = async () => {
  const auth = getBrowserAuth();
  if (!auth.currentUser) throw new Error('Sign in to verify your email.');
  await browserAuthSdk().sendEmailVerification(auth.currentUser, returnToJournal());
};
export const refreshAccount = async () => {
  const auth = getBrowserAuth();
  const user = auth.currentUser;
  if (user) {
    await browserAuthSdk().reload(user);
    if (auth.currentUser !== user)
      throw new Error('The journal account has changed. Please retry.');
    if (user.emailVerified) {
      await verifyJournalToken(user, true);
      requireVerifiedAccount(user.uid);
      if (connection?.uid === user.uid) await connection.refreshUser(user);
    } else {
      releaseAccount();
    }
    requireAccount(user.uid);
  }
  return notifyCheckedAccount(user);
};
export const resetPassword = (email: string) =>
  browserAuthSdk().sendPasswordResetEmail(getBrowserAuth(), email.trim(), returnToJournal());

export const resetLockedJournalPassword = (uid: string) => {
  const owner = requireAccount(uid);
  if (!owner.email || !isJournalLocked(uid)) throw new Error('The journal lock has changed.');
  return resetPassword(owner.email);
};

export const settledWrites = async (database: Firestore) => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      firestoreSdk().waitForPendingWrites(database),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                'Some journal changes are still on this device. Reconnect and wait for them to sync, then try again.',
              ),
            ),
          4000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
};
const writes = new Map<string, Set<Promise<unknown>>>();
const hasOutstandingWrites = (uid: string) => Boolean(writes.get(uid)?.size);
export const trackWrite = <T>(uid: string, operation: Promise<T>): Promise<T> => {
  const pending = writes.get(uid) ?? new Set();
  writes.set(uid, pending);
  pending.add(operation);
  const finished = () => {
    pending.delete(operation);
    if (!pending.size && writes.get(uid) === pending) writes.delete(uid);
  };
  operation.then(finished, finished);
  return operation;
};

export const trackProfileWrite = (uid: string, operation: Promise<void>) => {
  if (!isOfflineJournalEnabled(uid)) return trackWrite(uid, operation);
  const owner = requireAccount(uid);
  const login = currentLogin(owner);
  const usesJournal = usesJournalDatabase(owner);
  const release = holdJournalEdits(uid);
  let unsubscribe: (() => void) | undefined;
  // A forced account change can terminate Firestore without settling its write
  // promise. Release this login's sign-out guard when its session ends, too.
  const sessionEnded = new Promise<never>((_, reject) => {
    unsubscribe = browserAuthSdk().onIdTokenChanged(getBrowserAuth(), (user) => {
      if (
        !user ||
        !sameLogin(currentLogin(user), login) ||
        (usesJournal && !usesJournalDatabase(user))
      ) {
        reject(new Error('The journal account has changed. Please retry.'));
      }
    });
  });
  return trackWrite(
    uid,
    Promise.race([operation, sessionEnded]).finally(() => {
      unsubscribe?.();
      release();
    }),
  );
};

export const signOutAccount = async (displayedUid?: string) => {
  const auth = getBrowserAuth();
  const user = auth.currentUser;
  const interrupted = interruptedSignOut;
  const uid = interrupted?.uid ?? user?.uid;
  if (!uid || (displayedUid && displayedUid !== uid)) return;
  const owner: LoginOwner = interrupted ?? (user ? currentLogin(user) : { uid });
  if (user?.uid === uid && (!interrupted || sameLogin(currentLogin(user), owner))) {
    const existing =
      connection?.uid === uid ? await connection.database.catch(() => undefined) : undefined;
    if (existing) await settledWrites(existing);
    if (hasOutstandingWrites(uid) || hasPendingDeletion(uid, isOfflineJournalEnabled(uid))) {
      throw new Error('Journal changes are still syncing. Try signing out after they finish.');
    }
  }
  const finish = async () => {
    if (auth.currentUser !== user)
      throw new Error('The journal account has changed. Please retry.');
    const trusted = interrupted?.trusted ?? journalTrust(uid) ?? false;
    try {
      if (interrupted) {
        // After a reload Firebase can be using a fallback persistence. Clear
        // the original record only if it still belongs to the interrupted owner.
        const storage = trusted ? localStorage : sessionStorage;
        const key = loginPersistenceManager().fullUserKey;
        const remove = async () => {
          if (ownsStoredLogin(storage, key, owner)) storage.removeItem(key);
        };
        if (trusted && ownsStoredLogin(storage, key, owner)) await withLoginStorage(remove);
        else if (!trusted) await remove();
      }
      if (!user || (user.uid === uid && (!interrupted || sameLogin(currentLogin(user), owner)))) {
        signingOutOwner = owner;
        try {
          await browserAuthSdk().signOut(auth);
        } finally {
          signingOutOwner = undefined;
        }
      }
    } catch (error) {
      if (uid && !auth.currentUser) {
        setInterruptedSignOut({ ...owner, trusted });
        releaseAccount();
        for (const listener of refreshListeners) listener(visibleAccount(null));
      }
      throw error;
    }
    if (interruptedSignOut) {
      setInterruptedSignOut(null);
      await notifyCheckedAccount(auth.currentUser);
    }
    if (connection?.uid === uid) releaseAccount();
  };
  await signOutWithoutPendingEdits(uid, () => withAuthChange(finish));
};
