import type { Reading } from '../domain/types';
import { UncheckedDeletionsExportError } from '../domain/journalBackup';
import { holdRecoveryActivity } from './journalActivity';
import {
  clearRegistrationName,
  deletionReservationName,
  reserveVolatileDeletion,
} from './deletionReservation';
import {
  checkDeletion,
  requestStore,
  type DeletionCheck,
  type StoredDeletion,
} from './deletionStore';

export interface PendingDeletion extends StoredDeletion {
  durable: boolean;
}

type Process = (reading: Reading, claim: () => Promise<boolean>) => Promise<void>;
export type DeletionListener = (
  requests: PendingDeletion[],
  error?: string,
  storageUnreadable?: boolean,
) => void;
interface Entry extends PendingDeletion {
  ready: boolean;
  running: boolean;
  resolve?: () => void;
  reject?: (error: unknown) => void;
  outcome?: { error?: string };
  releaseVolatile?: () => void;
}

let volatileCount = 0;
const warnBeforeClose = (event: BeforeUnloadEvent) => {
  event.preventDefault();
  event.returnValue = true;
};
const holdVolatileRequest = (uid: string) => {
  const release = holdRecoveryActivity(uid);
  if (++volatileCount === 1) window.addEventListener('beforeunload', warnBeforeClose);
  return () => {
    release();
    if (--volatileCount === 0) window.removeEventListener('beforeunload', warnBeforeClose);
  };
};

// Record the attempt before sending a mutation. IDB serializes the read and
// update across tabs, including in browsers where Web Locks are unavailable.
// An ambiguous commit after a crash can then only be verified, never replayed.
const claimRequest = async (uid: string, key: string) => {
  let claimed = false;
  await requestStore(uid, 'readwrite', (store) => {
    const request = store.get(key);
    request.onsuccess = () => {
      const entry: StoredDeletion | undefined = request.result;
      if (entry && !entry.attempted) {
        store.put({ ...entry, attempted: true });
        claimed = true;
      }
    };
    return request;
  });
  return claimed;
};

// Each processor gets a distinct IndexedDB version for this request. Opening
// that version waits for the previous processor's connection to close, even
// across tabs without Web Locks. Closing or crashing a tab releases its handle.
const withRequestLock = async (
  uid: string,
  key: string,
  process: (saved: boolean) => Promise<void>,
) => {
  const name = 'arcana.journal.deletion-lock:' + key;
  for (;;) {
    let version = 0;
    await requestStore(uid, 'readwrite', (store) => {
      const read = store.get(key);
      read.onsuccess = () => {
        const saved: StoredDeletion | undefined = read.result;
        if (saved) {
          version = (saved.lockVersion ?? 0) + 1;
          store.put({ ...saved, lockVersion: version });
        }
      };
      return read;
    });
    if (!version) {
      await process(false);
      return;
    }
    let lock: IDBDatabase;
    try {
      lock = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(name, version);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
    } catch (error) {
      // A later ticket reached the database first. Never reuse its version.
      if (error instanceof DOMException && error.name === 'VersionError') continue;
      throw error;
    }
    try {
      // Queue cleanup now, so closing the tab also removes the empty lock DB.
      // The browser holds that deletion until every earlier handle closes.
      indexedDB.deleteDatabase(name);
      const saved = await requestStore(uid, 'readonly', (store) => store.getKey(key));
      await process(saved !== undefined);
    } finally {
      lock.close();
    }
    return;
  }
};

interface Queue {
  entries: Map<string, Entry>;
  listeners: Set<DeletionListener>;
  storageUnreadable?: boolean;
  retry?: ReturnType<typeof setTimeout>;
}
const queues = new Map<string, Queue>();
const queueFor = (uid: string, trusted: boolean) => {
  const key = (trusted ? 'device:' : 'session:') + uid;
  let queue = queues.get(key);
  if (!queue) {
    queue = { entries: new Map(), listeners: new Set() };
    queues.set(key, queue);
  }
  return queue;
};
const notify = (queue: Queue, error?: string) => {
  // Advertise a request to observers once its durability is known.
  const ready = [...queue.entries.values()].filter((entry) => entry.ready);
  for (const listener of queue.listeners) listener(ready, error, queue.storageUnreadable);
};
export const hasPendingDeletion = (uid: string, trusted: boolean) =>
  Boolean(queueFor(uid, trusted).entries.size);

// A window may lose access to IndexedDB while a sibling still has durable
// requests. A short-lived worker can check that same origin's queue.
const checkFromWorker = async (check: DeletionCheck, timeoutMs = 1500): Promise<boolean | null> => {
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    worker = new Worker(new URL('./checkDeletion.worker.js', import.meta.url));
    const reader = worker;
    return await new Promise<boolean | null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
      reader.onmessage = ({ data }) => resolve(typeof data === 'boolean' ? data : null);
      reader.onerror = () => resolve(null);
      reader.postMessage(check);
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    worker?.terminate();
  }
};
const importWaiting =
  'This reading has a pending deletion. Let it finish syncing, then retry the import.';

const checkFromBrowser = (check: DeletionCheck, timeoutMs?: number) => {
  // Some window policies hide the whole interface. Check the worker when
  // available before concluding this is an IndexedDB-only browser.
  if (check.kind === 'lock' && !('locks' in navigator) && typeof Worker === 'function')
    return checkFromWorker(check, timeoutMs);
  return checkDeletion(check).catch(() => checkFromWorker(check, timeoutMs));
};

const checkReservations = async (
  names: string[],
  busyMessage: string,
  onUnchecked: () => void,
  workerTimeoutMs?: number,
) => {
  if (!names.length) return;
  const reservations = await Promise.all([
    checkFromBrowser({ kind: 'lock', names }, workerTimeoutMs),
    checkFromBrowser({ kind: 'database', names }, workerTimeoutMs),
  ]);
  if (reservations.includes(true)) throw new Error(busyMessage);
  if (reservations.includes(null)) onUnchecked();
};

export const checkClearRegistration = (uid: string, onUnchecked: () => void) =>
  checkReservations(
    [clearRegistrationName(uid)],
    'A journal clear is starting. Let it finish syncing, then review the import again.',
    onUnchecked,
  );

// A confirmed delete leaves the list before its server transaction finishes.
// An import checking that same ID must see the result of the earlier request.
export const waitForDeletionBeforeImport = (
  uid: string,
  trusted: boolean,
  id: string,
  client: DeletionClient,
  onUnchecked: () => void,
) => {
  const queue = queueFor(uid, trusted);
  const earlier = [...queue.entries.values()].filter((entry) => entry.reading.id === id);
  return new Promise<void>((resolve, reject) => {
    let expired = false;
    const changed = () => {
      if (earlier.some((entry) => queue.entries.has(entry.key))) return;
      queue.listeners.delete(changed);
      const error = earlier.find((entry) => entry.outcome?.error)?.outcome?.error;
      if (error) {
        clearTimeout(timeout);
        reject(new Error(error));
        return;
      }
      const checkReading = async () => {
        const name = await deletionReservationName(uid, id);
        await checkReservations([name], importWaiting, onUnchecked);
      };
      void checkReading()
        .then(resolve, reject)
        .finally(() => clearTimeout(timeout));
    };
    const timeout = setTimeout(() => {
      expired = true;
      queue.listeners.delete(changed);
      reject(new Error(importWaiting));
    }, 4000);
    const check = async () => {
      let saved: StoredDeletion[];
      try {
        saved = await requestStore(uid, 'readonly', (store) => store.getAll(), []);
      } catch {
        const pending = await checkFromWorker({ kind: 'saved', uid, id });
        if (pending) throw new Error(importWaiting);
        if (pending === null) onUnchecked();
        saved = [];
      }
      if (expired) return;
      for (const request of saved) {
        if (request.reading.id !== id) continue;
        // A session-only login can see that a trusted request exists, while
        // the trusted session retains responsibility for replaying it.
        if (!trusted) throw new Error(importWaiting);
        const entry = restoreEntry(queue, request);
        if (!earlier.includes(entry)) earlier.push(entry);
      }
      queue.listeners.add(changed);
      flush(uid, queue, client);
      changed();
    };
    void check().catch((error) => {
      clearTimeout(timeout);
      queue.listeners.delete(changed);
      reject(error);
    });
  });
};

const restoreEntry = (queue: Queue, request: StoredDeletion) => {
  let entry = queue.entries.get(request.key);
  if (!entry) {
    entry = { ...request, durable: true, ready: true, running: false };
    queue.entries.set(request.key, entry);
  }
  return entry;
};

// Shared and session-only readers can inspect an existing queue without
// creating one or loading the stored readings into the session.
const countSavedDeletions = (uid: string) =>
  requestStore(uid, 'readonly', (store) => store.count(), 0);
const exportWaiting =
  'A deletion is still waiting to sync. Reconnect and finish syncing before exporting the journal.';

export const checkExportReservations = (names: string[], allowUncheckedDeletions: boolean) =>
  checkReservations(
    names,
    exportWaiting,
    () => {
      if (!allowUncheckedDeletions)
        throw new UncheckedDeletionsExportError(
          'This browser could not check deletions in other tabs. Restore browser access and retry, or choose Export available readings for a backup that may include readings waiting to be deleted.',
        );
    },
    5000,
  ); // Allow time for worker startup and a full batch on slower devices.

export const checkReadingsForPendingDeletions = async (
  uid: string,
  ids: string[],
  allowUncheckedDeletions = false,
) => {
  const names = await Promise.all(ids.map((id) => deletionReservationName(uid, id)));
  await checkExportReservations(names, allowUncheckedDeletions);
  return names;
};

export const checkDeletionsForExport = async (
  uid: string,
  trusted: boolean,
  allowUncheckedDeletions: boolean,
) => {
  const queue = queueFor(uid, trusted);
  if (queue.entries.size) throw new Error(exportWaiting);
  let count = 0;
  try {
    count = await countSavedDeletions(uid);
    if (queue.storageUnreadable) {
      queue.storageUnreadable = false;
      notify(queue);
    }
  } catch {
    queue.storageUnreadable = true;
    notify(queue);
    if (!allowUncheckedDeletions)
      throw new Error(
        'Allow access to browser storage to check saved deletions, or choose Export available readings.',
      );
  }
  if (count || queue.entries.size) throw new Error(exportWaiting);
  // A confirmed clear can be waiting for its first server commit. Its tab
  // holds this reservation until Firestore can report the clear itself.
  await checkExportReservations([clearRegistrationName(uid)], allowUncheckedDeletions);
};
const transient = (error: unknown) => {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
  return [
    'unavailable',
    'deadline-exceeded',
    'aborted',
    'cancelled',
    'resource-exhausted',
    'unknown',
    'internal',
    'auth/network-request-failed',
  ].includes(String(code));
};

interface DeletionClient {
  ownerIsCurrent: () => boolean;
  process: Process;
}

const flush = (uid: string, queue: Queue, client: DeletionClient) => {
  if (!navigator.onLine || !client.ownerIsCurrent()) return;
  for (const entry of queue.entries.values()) {
    if (!entry.ready || entry.running) continue;
    entry.running = true;
    const run = async (saved: boolean) => {
      if (!client.ownerIsCurrent()) return;
      // An observer can discard its stale copy once the owning tab retired it.
      // The originating caller still verifies the result for its own promise.
      if (!saved && !entry.resolve) entry.outcome = {};
      if (!entry.outcome) {
        const claim = async () => {
          if (entry.attempted) return false;
          try {
            const owned = !entry.durable || (await claimRequest(uid, entry.key));
            entry.attempted = true;
            return owned;
          } catch {
            throw Object.assign(new Error('Deletion storage is unavailable.'), {
              code: 'unavailable',
            });
          }
        };
        try {
          await client.process(entry.reading, claim);
          entry.outcome = {};
        } catch (error) {
          if (!client.ownerIsCurrent() || transient(error) || !navigator.onLine) throw error;
          // A terminal read error must also stay terminal if cleanup is interrupted.
          await claim();
          entry.outcome = {
            error: error instanceof Error ? error.message : 'Deletion did not finish.',
          };
        }
      }
      if (entry.durable && saved) {
        await requestStore(uid, 'readwrite', (store) => store.delete(entry.key));
      }
      queue.entries.delete(entry.key);
      entry.releaseVolatile?.();
      if (entry.outcome.error) entry.reject?.(new Error(entry.outcome.error));
      else entry.resolve?.();
      notify(queue, entry.outcome.error);
    };
    const execute = entry.durable ? withRequestLock(uid, entry.key, run) : run(true);
    void execute
      .catch(() => {
        if (entry.outcome && client.ownerIsCurrent()) {
          notify(
            queue,
            'The server checked this deletion. Allow browser storage and retry to finish clearing the local request.',
          );
        }
        if (client.ownerIsCurrent() && queue.listeners.size && !queue.retry) {
          queue.retry = setTimeout(() => {
            queue.retry = undefined;
            flush(uid, queue, client);
          }, 3000);
        }
      })
      .finally(() => {
        entry.running = false;
      });
  }
};

export const enqueueDeletion = (
  uid: string,
  reading: Reading,
  trusted: boolean,
  client: DeletionClient,
) =>
  new Promise<void>((resolve, reject) => {
    const queue = queueFor(uid, trusted);
    const entry: Entry = {
      key: crypto.randomUUID(),
      reading,
      durable: false,
      ready: false,
      running: false,
      resolve,
      reject,
      releaseVolatile: holdVolatileRequest(uid),
    };
    queue.entries.set(entry.key, entry);
    notify(queue);
    void (async () => {
      if (trusted) {
        try {
          await requestStore(uid, 'readwrite', (store) => store.add({ key: entry.key, reading }));
          entry.durable = true;
          entry.releaseVolatile?.();
          entry.releaseVolatile = undefined;
        } catch {
          // Shared and storage-restricted sessions retain their request in this tab.
        }
      }
      if (!entry.durable) {
        // Publish before dispatching the Firestore transaction. The browser
        // releases this reservation on tab closure.
        try {
          const release = await reserveVolatileDeletion(
            await deletionReservationName(uid, reading.id),
          );
          const releaseActivity = entry.releaseVolatile!;
          entry.releaseVolatile = () => {
            release();
            releaseActivity();
          };
        } catch {
          const message =
            'This browser could not register the deletion with other tabs. Restore browser storage access and confirm the deletion again.';
          entry.outcome = { error: message };
          queue.entries.delete(entry.key);
          entry.releaseVolatile?.();
          notify(queue, message);
          reject(new Error(message));
          return;
        }
      }
      entry.ready = true;
      notify(queue);
      flush(uid, queue, client);
    })();
  });

export const observeDeletions = (
  uid: string,
  trusted: boolean,
  client: DeletionClient,
  listener: DeletionListener,
) => {
  const queue = queueFor(uid, trusted);
  let mounted = true;
  queue.listeners.add(listener);
  const resume = async () => {
    try {
      let saved: StoredDeletion[] = [];
      if (trusted) {
        saved = await requestStore(uid, 'readonly', (store) => store.getAll());
      } else await countSavedDeletions(uid);
      if (!mounted || !client.ownerIsCurrent()) return;
      queue.storageUnreadable = false;
      for (const request of saved) restoreEntry(queue, request);
    } catch {
      if (!mounted || !client.ownerIsCurrent()) return;
      // A trusted tab may have already saved requests for this account.
      queue.storageUnreadable = true;
    }
    notify(queue);
    flush(uid, queue, client);
  };
  notify(queue);
  void resume();
  window.addEventListener('online', resume);
  window.addEventListener('focus', resume);
  return () => {
    mounted = false;
    queue.listeners.delete(listener);
    window.removeEventListener('online', resume);
    window.removeEventListener('focus', resume);
    if (!queue.listeners.size && queue.retry) {
      clearTimeout(queue.retry);
      queue.retry = undefined;
    }
  };
};
