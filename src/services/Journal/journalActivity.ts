const activityName = (uid: string) => 'arcana.journal.edits.' + uid;

// The browser releases these per-tab locks on close. The name contains no reading
// data, and the exporting tab can include its own in-memory copies directly.
const backupPrefix = (uid: string) => 'arcana.journal.backup.' + encodeURIComponent(uid) + ':';
let tabId: string | undefined;
const currentTab = () => (tabId ??= crypto.randomUUID());
const backupLockName = (uid: string) => backupPrefix(uid) + currentTab();
const backupHolders = new Map<string, { count: number; release: () => void }>();

const openBackupChannel = (uid: string) => {
  try {
    return new BroadcastChannel(backupPrefix(uid));
  } catch {
    return undefined;
  }
};

export const holdRecoveryActivity = (uid: string): (() => void) => {
  let holder = backupHolders.get(uid);
  if (!holder) {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const channel = openBackupChannel(uid);
    if (channel)
      channel.onmessage = ({ data }) => {
        if (data?.kind === 'check' && data.tab !== currentTab())
          channel.postMessage({ respondingTo: data.request });
      };
    holder = {
      count: 0,
      release: () => {
        channel?.close();
        release();
      },
    };
    backupHolders.set(uid, holder);
    try {
      void navigator.locks?.request(backupLockName(uid), () => held).catch(() => {});
    } catch {
      // Browsers without lock coordination can export the cloud and current tab.
    }
  }
  holder.count++;
  return () => {
    if (--holder.count === 0) {
      holder.release();
      backupHolders.delete(uid);
    }
  };
};

export const checkSiblingRecovery = async (uid: string): Promise<'clear' | 'unknown' | 'busy'> => {
  let status: 'clear' | 'unknown' = 'unknown';
  try {
    // Some policies expose query() but reject lock acquisition. In that case
    // other tabs cannot be relied upon to have advertised their recovery.
    const { held = [], pending = [] } = await navigator.locks.request(
      'arcana.journal.check-backup',
      { mode: 'shared' },
      () => navigator.locks.query(),
    );
    const own = backupLockName(uid);
    const prefix = backupPrefix(uid);
    if ([...held, ...pending].some(({ name }) => name?.startsWith(prefix) && name !== own))
      return 'busy';
    status = 'clear';
  } catch {
    // An active sibling may still be able to respond using BroadcastChannel.
  }
  const channel = openBackupChannel(uid);
  if (!channel) return status;
  try {
    const request = crypto.randomUUID();
    const busy = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 200);
      channel.onmessage = ({ data }) => {
        if (data?.respondingTo === request) {
          clearTimeout(timeout);
          resolve(true);
        }
      };
      channel.postMessage({ kind: 'check', tab: currentTab(), request });
    });
    return busy ? 'busy' : status;
  } catch {
    return 'unknown';
  } finally {
    channel.close();
  }
};

// Web Locks are shared by tabs even when Firestore has to use memory. The
// browser releases a closed tab's locks without relying on an unload event.
export const holdJournalEdits = (uid: string): (() => void) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    void navigator.locks
      ?.request(activityName(uid), { mode: 'shared' }, () => held)
      .catch(() => {});
  } catch {
    // Reading recovery also keeps an owner-bound copy if this API is restricted.
  }
  return release;
};

export const signOutWithoutPendingEdits = async (uid: string, signOut: () => Promise<void>) => {
  let checked = false;
  try {
    if (navigator.locks) {
      await navigator.locks.request(activityName(uid), { ifAvailable: true }, async (lock) => {
        checked = true;
        if (!lock) {
          throw new Error(
            'Another tab has unsynced journal changes. Keep it open and wait for it to sync before signing out.',
          );
        }
        await signOut();
      });
      return;
    }
  } catch (error) {
    if (checked) throw error;
    // Some browsers expose Web Locks but deny requests. Unsynced readings
    // remain recoverable by their owner in the originating tab in this case.
  }
  await signOut();
};
