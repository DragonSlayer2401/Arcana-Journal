import { initializeApp, deleteApp } from 'firebase/app';
import {
  browserLocalPersistence,
  browserSessionPersistence,
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  initializeAuth,
  inMemoryPersistence,
  onAuthStateChanged,
  reload,
  sendEmailVerification,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  updateCurrentUser,
  type User,
} from 'firebase/auth';
import {
  connectFirestoreEmulator,
  initializeFirestore,
  memoryLocalCache,
  persistentLocalCache,
  persistentMultipleTabManager,
  terminate,
  waitForPendingWrites,
  type Firestore,
} from 'firebase/firestore';

const useEmulators = import.meta.env.MODE === 'emulator';
const config = {
  apiKey: useEmulators ? 'demo-arcana-journal' : 'AIzaSyBv7MUeAR9AKuIxtTl9Bo-OflYtye7yHZk',
  authDomain: 'arcana-journal.firebaseapp.com',
  projectId: useEmulators ? 'demo-arcana-journal' : 'arcana-journal',
  appId: '1:119895825487:web:d615c201127d7eb9e4de3a',
  messagingSenderId: '119895825487',
};
const app = initializeApp(config);
const auth = initializeAuth(app, {
  persistence: [browserLocalPersistence, browserSessionPersistence, inMemoryPersistence],
});
if (useEmulators) connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });

export interface JournalUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
}

const asAccount = (user: User | null): JournalUser | null =>
  user && { uid: user.uid, email: user.email, emailVerified: user.emailVerified };

const trustKey = (uid: string) => 'arcana.journal.trusted.' + uid;
export const isOfflineJournalEnabled = (uid: string): boolean => {
  try {
    return localStorage.getItem(trustKey(uid)) === 'yes';
  } catch {
    return false;
  }
};

export const requireAccount = (uid: string): User => {
  const user = auth.currentUser;
  if (!user || user.uid !== uid) throw new Error('The journal account has changed. Please retry.');
  return user;
};

interface AccountConnection {
  uid: string;
  trusted: boolean;
  database: Promise<Firestore>;
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

export const databaseFor = (uid: string): Promise<Firestore> => {
  const user = requireAccount(uid);
  const trusted = isOfflineJournalEnabled(uid);
  if (connection?.uid === uid && connection.trusted === trusted) return connection.database;
  releaseAccount();
  // A Firebase app name is part of the Firestore IndexedDB namespace. A trusted
  // journal can therefore resume offline writes without sharing cache with a different login.
  const name = 'journal-' + uid + (trusted ? '-device' : '-session');
  const opened = closing.then(async () => {
    requireAccount(uid);
    const journalApp = initializeApp(config, name);
    try {
      const journalAuth = initializeAuth(journalApp, { persistence: inMemoryPersistence });
      if (useEmulators) {
        connectAuthEmulator(journalAuth, 'http://127.0.0.1:9099', { disableWarnings: true });
      }
      // Both Firebase apps use the same API key and project. Copy the restored
      // SDK user into this cache's in-memory Auth instance, including on offline reload.
      await updateCurrentUser(journalAuth, user);
      requireAccount(uid);
      const database = initializeFirestore(journalApp, {
        localCache: trusted
          ? persistentLocalCache({ tabManager: persistentMultipleTabManager() })
          : memoryLocalCache(),
      });
      if (useEmulators) connectFirestoreEmulator(database, '127.0.0.1', 8080);
      return { database, journalApp };
    } catch (error) {
      await deleteApp(journalApp);
      throw error;
    }
  });
  const next: AccountConnection = {
    uid,
    trusted,
    database: opened.then(({ database }) => database),
    close: async () => {
      const { database, journalApp } = await opened;
      try {
        await terminate(database);
      } finally {
        await deleteApp(journalApp);
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
const refreshListeners = new Set<(user: JournalUser | null) => void>();
export const observeAccount = (onUser: (user: JournalUser | null) => void): (() => void) => {
  let active = true;
  refreshListeners.add(onUser);
  const unsubscribe = onAuthStateChanged(auth, async () => {
    await settling;
    if (!active) return;
    const user = auth.currentUser;
    if (connection && connection.uid !== user?.uid) releaseAccount();
    onUser(asAccount(user));
  });
  return () => {
    active = false;
    refreshListeners.delete(onUser);
    unsubscribe();
  };
};

const authenticate = async (
  email: string,
  password: string,
  trusted: boolean,
  register: boolean,
) => {
  if (authBusy) throw new Error('An account request is already in progress.');
  authBusy = true;
  let finished!: () => void;
  settling = new Promise<void>((resolve) => {
    finished = resolve;
  });
  try {
    await setPersistence(auth, trusted ? browserLocalPersistence : browserSessionPersistence);
    const credential = register
      ? await createUserWithEmailAndPassword(auth, email.trim(), password)
      : await signInWithEmailAndPassword(auth, email.trim(), password);
    try {
      if (trusted) localStorage.setItem(trustKey(credential.user.uid), 'yes');
      else localStorage.removeItem(trustKey(credential.user.uid));
    } catch {
      // Restricted browsers still support a session-only journal.
    }
  } finally {
    authBusy = false;
    finished();
  }
};

const returnToJournal = () => ({
  url:
    (useEmulators ? window.location.origin : 'https://arcana-journal.jacobskip7.workers.dev') +
    '/journal',
});
export const signIn = (email: string, password: string, trusted = false) =>
  authenticate(email, password, trusted, false);
export const signUp = async (email: string, password: string, trusted = false) => {
  await authenticate(email, password, trusted, true);
  await sendVerification();
};
export const sendVerification = async () => {
  if (!auth.currentUser) throw new Error('Sign in to verify your email.');
  await sendEmailVerification(auth.currentUser, returnToJournal());
};
export const refreshAccount = async () => {
  const user = auth.currentUser;
  if (user) await reload(user);
  const active = asAccount(auth.currentUser);
  for (const listener of refreshListeners) listener(active);
  return active;
};
export const resetPassword = (email: string) =>
  sendPasswordResetEmail(auth, email.trim(), returnToJournal());

export const settledWrites = async (database: Firestore) => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      waitForPendingWrites(database),
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
export const signOutAccount = async () => {
  const uid = auth.currentUser?.uid;
  if (uid) {
    const existing =
      connection?.uid === uid ? await connection.database.catch(() => undefined) : undefined;
    if (existing) await settledWrites(existing);
    if (writes.get(uid)?.size) {
      throw new Error('Journal changes are still syncing. Try signing out after they finish.');
    }
    requireAccount(uid);
  }
  await signOut(auth);
  releaseAccount();
};
