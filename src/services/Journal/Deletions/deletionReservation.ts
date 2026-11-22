import { withStorageLock } from '@/utils/storageLock';

export const clearRegistrationName = (uid: string) =>
  'arcana.journal.register-clear:' + encodeURIComponent(uid);

// Portable reading IDs can contain personal text. Only their account-scoped
// fingerprint belongs in a resource name shared by the browser.
export const deletionReservationName = async (uid: string, id: string) => {
  const bytes = new TextEncoder().encode(JSON.stringify([uid, id]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return (
    'arcana.journal.volatile-delete:' +
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  );
};

export const reserveVolatileDeletion = async (name: string): Promise<() => void> => {
  try {
    return await new Promise<() => void>((resolve, reject) => {
      void withStorageLock(name, () => new Promise<void>((release) => resolve(release))).catch(
        reject,
      );
    });
  } catch {
    // Older or restricted browsers can hold an empty IndexedDB database.
    // Queuing its removal immediately also releases it if the tab crashes.
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(name);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      indexedDB.deleteDatabase(name);
    } catch (error) {
      database.close();
      throw error;
    }
    return () => database.close();
  }
};
