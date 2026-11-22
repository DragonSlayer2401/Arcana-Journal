import { StorageLockUnavailableError, withStorageLock } from '@/utils/storageLock';

const lockName = 'arcana.guest-journal.write';
const unavailableMessage =
  'This browser cannot coordinate guest journal changes across tabs. Restore browser storage access and retry.';

// On browsers predating Web Locks, a read/write transaction on one object
// store serializes every tab. Keep the localStorage read and write synchronous
// inside the request callback, while IndexedDB guarantees exclusive access.
const withLegacyGuestLock = async <T>(change: () => T): Promise<T> => {
  let database: IDBDatabase | undefined;
  let started = false;
  try {
    database = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(lockName, 1);
      open.onupgradeneeded = () => open.result.createObjectStore('writers');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => resolve(open.result);
    });
    const transaction = database.transaction('writers', 'readwrite');
    const ready = transaction.objectStore('writers').get('turn');
    return await new Promise<T>((resolve, reject) => {
      transaction.onabort = () => reject(transaction.error);
      ready.onsuccess = () => {
        started = true;
        try {
          resolve(change());
        } catch (error) {
          reject(error);
        }
      };
    });
  } catch (error) {
    if (started) throw error;
    throw new StorageLockUnavailableError(unavailableMessage);
  } finally {
    database?.close();
  }
};

// Keep rapid input in order even when separate worker startups complete out of order.
let previous: Promise<void> = Promise.resolve();
export const waitForGuestWrites = () => previous;
let pending = 0;
const warnBeforeClose = (event: BeforeUnloadEvent) => {
  event.preventDefault();
  event.returnValue = true;
};
const finished = () => {
  if (--pending === 0) window.removeEventListener('beforeunload', warnBeforeClose);
};
export const withGuestWrite = <T>(
  change: () => T extends PromiseLike<unknown> ? never : T,
  unavailable?: () => T | Promise<T>,
): Promise<T> => {
  if (++pending === 1) window.addEventListener('beforeunload', warnBeforeClose);
  const next = previous.then(async () => {
    try {
      // A denied window on a modern browser must coordinate with tabs using
      // Web Locks. Only platforms without that API use the IndexedDB mutex.
      if (!('LockManager' in window) && !('locks' in navigator))
        return await withLegacyGuestLock(change);
      return await withStorageLock(lockName, change);
    } catch (error) {
      if (!(error instanceof StorageLockUnavailableError)) throw error;
      if (unavailable) return unavailable();
      throw new StorageLockUnavailableError(unavailableMessage);
    }
  });
  previous = next.then(finished, finished);
  return next;
};
