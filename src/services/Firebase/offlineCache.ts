// Firestore's clearIndexedDbPersistence() also drops queued writes and tells
// other live clients to terminate. Acquire IndexedDB's exclusive upgrade
// transaction first, including for caches created by older app versions.
const busy =
  'This account’s offline journal is still on this device. Let changes sync in the other journal tabs, close those tabs, then retry removal.';
export const pendingOfflineChanges =
  'This account still has journal changes on this device. Keep any tab with unsynced readings open. Sync or recover them in the trusted journal, then sign in with device trust off and retry removal.';
export const offlineStorageUnavailable =
  'This browser could not finish checking or removing this account’s offline journal. Allow browser storage access, then retry removal.';
export class OfflineRemovalBlocked extends Error {}
// @firebase/firestore uses the mutations store through IndexedDB schema 18.
// A newer nonempty cache must be checked by an app that knows its write queue.
const latestKnownSchema = 18;

const versionOf = (name: string): Promise<number | null> =>
  new Promise((resolve, reject) => {
    // Aborting the initial upgrade leaves a shared device with no new database.
    const request = indexedDB.open(name);
    let missing = false;
    const timeout = setTimeout(() => reject(new OfflineRemovalBlocked(busy)), 2000);
    request.onupgradeneeded = () => {
      missing = true;
      request.transaction!.abort();
    };
    request.onerror = () => {
      clearTimeout(timeout);
      if (missing) resolve(null);
      else reject(request.error);
    };
    request.onsuccess = () => {
      clearTimeout(timeout);
      const database = request.result;
      database.close();
      resolve(database.version);
    };
  });

const cacheName = (appName: string, projectId: string) =>
  'firestore/' + appName + '/' + projectId + '/main';
export const hasOfflineCache = async (appName: string, projectId: string) =>
  (await versionOf(cacheName(appName, projectId))) !== null;

export const eraseOfflineCache = async (appName: string, projectId: string) => {
  // The Firebase app name is the persistence key for this account. The queue
  // store is part of the installed Web SDK schema. Fail closed on unknown layouts.
  const name = cacheName(appName, projectId);
  const version = await versionOf(name);
  if (version === null) return;
  await new Promise<void>((resolve, reject) => {
    const open = indexedDB.open(name, version + 1);
    let cancelled = false;
    let failure = offlineStorageUnavailable;
    const cancel = () => {
      cancelled = true;
      reject(new OfflineRemovalBlocked(busy));
    };
    const timeout = setTimeout(cancel, 2000);
    open.onblocked = cancel;
    open.onerror = () => {
      clearTimeout(timeout);
      reject(new OfflineRemovalBlocked(failure));
    };
    open.onupgradeneeded = (event) => {
      clearTimeout(timeout);
      const database = open.result;
      const transaction = open.transaction!;
      if (cancelled || event.oldVersion !== version) return transaction.abort();
      // No new client can enqueue a write between this check and erasure.
      // A crash after commit can leave the empty database awaiting deletion.
      if (database.objectStoreNames.length === 0) return;
      if (event.oldVersion > latestKnownSchema) {
        failure =
          'This account’s offline journal was saved by a newer version of the app. Reopen the latest version to check its pending changes and retry removal.';
        return transaction.abort();
      }
      if (!database.objectStoreNames.contains('mutations')) return transaction.abort();
      const count = transaction.objectStore('mutations').count();
      count.onsuccess = () => {
        if (count.result > 0) {
          failure = pendingOfflineChanges;
          transaction.abort();
        } else {
          for (const store of Array.from(database.objectStoreNames))
            database.deleteObjectStore(store);
        }
      };
    };
    open.onsuccess = () => {
      clearTimeout(timeout);
      const database = open.result;
      // Another cleanup could have created this version. Only remove a shell
      // that has already been emptied and can no longer accept SDK writes.
      if (database.objectStoreNames.length || cancelled) {
        database.close();
        reject(new OfflineRemovalBlocked(busy));
        return;
      }
      try {
        const removal = indexedDB.deleteDatabase(name);
        const deadline = setTimeout(() => reject(new OfflineRemovalBlocked(busy)), 2000);
        removal.onerror = () => {
          clearTimeout(deadline);
          reject(new Error(offlineStorageUnavailable));
        };
        removal.onblocked = () => {
          clearTimeout(deadline);
          reject(new OfflineRemovalBlocked(busy));
        };
        removal.onsuccess = () => {
          clearTimeout(deadline);
          resolve();
        };
      } catch {
        reject(new Error(offlineStorageUnavailable));
      } finally {
        database.close();
      }
    };
  });
};
