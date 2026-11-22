import type { Reading } from '../domain/types';

export interface StoredDeletion {
  key: string;
  reading: Reading;
  attempted?: boolean;
  lockVersion?: number;
}

export const requestStore = async <T>(
  uid: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
  ifMissing?: T,
): Promise<T> => {
  const database = await new Promise<IDBDatabase | null>((resolve, reject) => {
    let absent = false;
    const open = indexedDB.open('arcana.journal.deletions.v1:' + uid, 1);
    open.onupgradeneeded = () => {
      if (ifMissing !== undefined) {
        absent = true;
        open.transaction!.abort();
      } else open.result.createObjectStore('requests', { keyPath: 'key' });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => (absent ? resolve(null) : reject(open.error));
  });
  if (!database) return ifMissing!;
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction('requests', mode);
      const result = action(transaction.objectStore('requests'));
      transaction.oncomplete = () => resolve(result.result);
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('Deletion storage unavailable.'));
    });
  } finally {
    database.close();
  }
};

export type DeletionCheck =
  | { kind: 'saved'; uid: string; id: string }
  | { kind: 'database' | 'lock'; name: string }
  | { kind: 'database' | 'lock'; names: string[] };

// Only the empty reservation DB uses this name. A held connection blocks
// removal. If its own cleanup is already queued, removal waits behind it.
const probeReservationDatabase = (name: string) =>
  new Promise<boolean>((resolve, reject) => {
    const removal = indexedDB.deleteDatabase(name);
    // A writer already queued its own deletion. In that case this request
    // cannot fire even a blocked event until the writer closes its handle.
    const timeout = setTimeout(() => resolve(true), 750);
    removal.onblocked = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    removal.onsuccess = () => {
      clearTimeout(timeout);
      resolve(false);
    };
    removal.onerror = () => {
      clearTimeout(timeout);
      reject(removal.error);
    };
  });

// The same checks run in a worker when the window cannot access an API.
// A session-only browser can check existing requests without creating a store.
export const checkDeletion = async (check: DeletionCheck) => {
  if (check.kind === 'saved') {
    const saved: StoredDeletion[] = await requestStore(
      check.uid,
      'readonly',
      (store) => store.getAll(),
      [],
    );
    return saved.some((request) => request.reading.id === check.id);
  }
  const names = 'names' in check ? check.names : [check.name];
  const requested = new Set(names);
  if (check.kind === 'lock') {
    // Browsers predating Web Locks use IndexedDB reservations throughout.
    // A restricted window in a browser that implements locks still has to
    // check its worker before treating a missing window API as conclusive.
    if (!('locks' in navigator) && !('LockManager' in globalThis)) return false;
    const { held = [], pending = [] } = await navigator.locks.query();
    return [...held, ...pending].some(({ name }) => name !== undefined && requested.has(name));
  }
  if (indexedDB.databases) {
    try {
      return (await indexedDB.databases()).some(
        ({ name }) => name !== undefined && requested.has(name),
      );
    } catch {
      // Some policies restrict database enumeration while allowing access
      // to this specific, empty reservation database.
    }
  }
  // Bound simultaneous direct probes on engines without enumeration. A
  // known pending deletion still blocks when a different probe was denied.
  let unreadable = false;
  for (let offset = 0; offset < names.length; offset += 32) {
    const results = await Promise.allSettled(
      names.slice(offset, offset + 32).map(probeReservationDatabase),
    );
    if (results.some((result) => result.status === 'fulfilled' && result.value)) return true;
    if (results.some((result) => result.status === 'rejected')) unreadable = true;
  }
  if (unreadable) throw new Error('Could not check every deletion reservation.');
  return false;
};
