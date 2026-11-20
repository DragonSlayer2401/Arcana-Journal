import {
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  documentId,
  getDocFromServer,
  getDocsFromServer,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  setDoc,
  startAfter,
  updateDoc,
  type DocumentSnapshot,
  type Firestore,
} from 'firebase/firestore';
import { createJournalBackup, mergeReveals, resolveImportReading } from '../domain/journalBackup';
import { isReading } from '../domain/storage';
import type { Reading } from '../domain/types';
import { databaseFor, requireAccount, settledWrites, trackWrite } from './account';

export {
  isOfflineJournalEnabled,
  observeAccount,
  refreshAccount,
  resetPassword,
  sendVerification,
  signIn,
  signOutAccount,
  signUp,
  type JournalUser,
} from './account';

const readingsFor = (database: Firestore, uid: string) =>
  collection(database, 'users', uid, 'readings');

// Portable IDs may contain slashes or exceed Firestore's path segment limit.
// Retain the exact ID inside the document and use a fixed-size key for lookups.
const readingRef = async (database: Firestore, uid: string, id: string) => {
  const bytes = new TextEncoder().encode(id);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  return doc(readingsFor(database, uid), key);
};

const revealedSlots = (reading: Reading) =>
  reading.revealed.flatMap((revealed, index) => (revealed ? [index] : []));

const encodeReading = (reading: Reading) => ({
  id: reading.id,
  question: reading.question,
  createdAt: reading.createdAt,
  createdAtMs: Date.parse(reading.createdAt),
  cardIds: reading.cards.map(({ cardId }) => cardId),
  orientations: reading.cards.map(({ orientation }) => orientation),
  revealedSlots: revealedSlots(reading),
});

const decodeReading = (snapshot: DocumentSnapshot): Reading => {
  const data = snapshot.data();
  if (
    data &&
    Array.isArray(data.cardIds) &&
    Array.isArray(data.orientations) &&
    Array.isArray(data.revealedSlots) &&
    data.orientations.length === data.cardIds.length
  ) {
    const reading = {
      id: data.id,
      createdAt: data.createdAt,
      question: data.question,
      cards: data.cardIds.map((cardId, index) => ({
        cardId,
        orientation: data.orientations[index],
      })),
      revealed: data.cardIds.map((_, index) => data.revealedSlots.includes(index)),
    };
    if (
      isReading(reading) &&
      data.createdAtMs === Date.parse(reading.createdAt) &&
      data.revealedSlots.every(
        (slot: unknown) =>
          typeof slot === 'number' &&
          Number.isInteger(slot) &&
          slot >= 0 &&
          slot < reading.cards.length,
      )
    ) {
      return reading;
    }
  }
  throw new Error(
    'A reading in this account could not be loaded. Your cloud journal has not been changed.',
  );
};

export interface JournalSyncState {
  fromCache: boolean;
  pending: boolean;
  hasMore: boolean;
}

const listen = (
  uid: string,
  subscribe: (database: Firestore, active: () => boolean) => Promise<() => void> | (() => void),
  onError: (error: Error) => void,
): (() => void) => {
  let cancelled = false;
  let stop: (() => void) | undefined;
  const active = () => {
    if (cancelled) return false;
    try {
      requireAccount(uid);
      return true;
    } catch {
      return false;
    }
  };
  void (async () => {
    try {
      const database = await databaseFor(uid);
      if (!active()) return;
      stop = await subscribe(database, active);
      if (cancelled) stop();
    } catch (error) {
      if (active())
        onError(error instanceof Error ? error : new Error('Could not open this journal.'));
    }
  })();
  return () => {
    cancelled = true;
    stop?.();
  };
};

export const observeReadings = (
  uid: string,
  count: number,
  onChange: (readings: Reading[], state: JournalSyncState) => void,
  onError: (error: Error) => void,
) =>
  listen(
    uid,
    (database, active) => {
      const recent = query(
        readingsFor(database, uid),
        orderBy('createdAtMs', 'desc'),
        limit(count + 1),
      );
      return onSnapshot(
        recent,
        { includeMetadataChanges: true },
        (snapshot) => {
          if (!active()) return;
          try {
            onChange(snapshot.docs.slice(0, count).map(decodeReading), {
              fromCache: snapshot.metadata.fromCache,
              pending: snapshot.metadata.hasPendingWrites,
              hasMore: snapshot.size > count,
            });
          } catch (error) {
            onError(error as Error);
          }
        },
        (error) => {
          if (active()) onError(error);
        },
      );
    },
    onError,
  );

export const observeReading = (
  uid: string,
  id: string,
  onChange: (reading: Reading | null) => void,
  onError: (error: Error) => void,
) =>
  listen(
    uid,
    async (database, active) => {
      const reference = await readingRef(database, uid, id);
      return onSnapshot(
        reference,
        { includeMetadataChanges: true },
        (snapshot) => {
          if (
            !active() ||
            (!snapshot.exists() &&
              snapshot.metadata.fromCache &&
              !snapshot.metadata.hasPendingWrites)
          )
            return;
          try {
            onChange(snapshot.exists() ? decodeReading(snapshot) : null);
          } catch (error) {
            onError(error as Error);
          }
        },
        (error) => {
          if (active()) onError(error);
        },
      );
    },
    onError,
  );

// Keep the order of local SDK dispatch even if hashing the document keys completes
// out of order. A reveal can follow an offline draw without waiting for a server ack.
const dispatches = new Map<string, Promise<void>>();
const withReading = (
  uid: string,
  id: string,
  write: (reference: Awaited<ReturnType<typeof readingRef>>) => Promise<void>,
) => {
  const dispatched = (dispatches.get(uid) ?? Promise.resolve()).then(async () => {
    const reference = await readingRef(await databaseFor(uid), uid, id);
    requireAccount(uid);
    return { acknowledgement: write(reference) };
  });
  const queued = dispatched.then(
    () => {},
    () => {},
  );
  dispatches.set(uid, queued);
  void queued.then(() => {
    if (dispatches.get(uid) === queued) dispatches.delete(uid);
  });
  return trackWrite(
    uid,
    dispatched.then(({ acknowledgement }) => acknowledgement),
  );
};

export const createReading = (uid: string, reading: Reading) =>
  withReading(uid, reading.id, (reference) => setDoc(reference, encodeReading(reading)));

export const revealCards = (uid: string, id: string, indexes: number[]) =>
  withReading(uid, id, (reference) =>
    updateDoc(reference, { revealedSlots: arrayUnion(...indexes) }),
  );

export const removeReading = (uid: string, id: string) =>
  withReading(uid, id, (reference) => deleteDoc(reference));

const pageSize = 100;
const onlineDatabase = async (uid: string) => {
  if (!navigator.onLine)
    throw new Error('Connect to the internet to access your complete account journal.');
  const database = await databaseFor(uid);
  await settledWrites(database);
  requireAccount(uid);
  return database;
};
const readPage = async (database: Firestore, uid: string, cursor: string | null) => {
  requireAccount(uid);
  const source = query(readingsFor(database, uid), orderBy(documentId()));
  const page = await getDocsFromServer(
    cursor ? query(source, startAfter(cursor), limit(pageSize)) : query(source, limit(pageSize)),
  );
  requireAccount(uid);
  if (page.metadata.hasPendingWrites)
    throw new Error('Wait for your journal to finish syncing, then try again.');
  return page;
};
export const exportAccountJournal = async (uid: string): Promise<string> => {
  const database = await onlineDatabase(uid);
  return createJournalBackup(async (cursor) => {
    const page = await readPage(database, uid, cursor);
    return {
      readings: page.docs.map(decodeReading),
      nextCursor: page.size === pageSize ? page.docs[page.size - 1].id : null,
    };
  });
};

export const clearReadings = (uid: string) =>
  trackWrite(
    uid,
    (async () => {
      const database = await onlineDatabase(uid);
      let cursor: string | null = null;
      do {
        const page = await readPage(database, uid, cursor);
        if (page.empty) return;
        await runTransaction(database, async (transaction) => {
          requireAccount(uid);
          for (const entry of page.docs) transaction.delete(entry.ref);
        });
        cursor = page.size === pageSize ? page.docs[page.size - 1].id : null;
      } while (cursor !== null);
    })(),
  );

type ImportResult = { added: number; updated: number; skipped: number };
const emptyResult = (): ImportResult => ({ added: 0, updated: 0, skipped: 0 });
const importChange = (existing: Reading | undefined, incoming: Reading) => {
  if (!existing) return 'added';
  return mergeReveals(existing, incoming) === existing ? 'skipped' : 'updated';
};

type ImportProgress = (completed: number, total: number) => void;
export const previewAccountImport = async (
  uid: string,
  readings: Reading[],
  onProgress?: ImportProgress,
): Promise<ImportResult> => {
  const database = await onlineDatabase(uid);
  const known = new Map<string, Reading | undefined>();
  const result = emptyResult();
  for (const incoming of readings) {
    requireAccount(uid);
    const { id, existing } = await resolveImportReading(incoming, async (id) => {
      if (!known.has(id)) {
        const snapshot = await getDocFromServer(await readingRef(database, uid, id));
        known.set(id, snapshot.exists() ? decodeReading(snapshot) : undefined);
      }
      return known.get(id);
    });
    result[importChange(existing, incoming)]++;
    known.set(id, existing ? mergeReveals(existing, incoming) : { ...incoming, id });
    onProgress?.(result.added + result.skipped + result.updated, readings.length);
  }
  requireAccount(uid);
  return result;
};

export const importAccountReadings = (
  uid: string,
  readings: Reading[],
  onProgress?: ImportProgress,
) =>
  trackWrite(
    uid,
    (async () => {
      const database = await onlineDatabase(uid);
      const result = emptyResult();
      for (const incoming of readings) {
        const change = await runTransaction(database, async (transaction) => {
          requireAccount(uid);
          const { id, existing } = await resolveImportReading(incoming, async (id) => {
            const snapshot = await transaction.get(await readingRef(database, uid, id));
            return snapshot.exists() ? decodeReading(snapshot) : undefined;
          });
          requireAccount(uid);
          const action = importChange(existing, incoming);
          const reference = await readingRef(database, uid, id);
          if (action === 'added') transaction.set(reference, encodeReading({ ...incoming, id }));
          if (action === 'updated')
            transaction.update(reference, {
              revealedSlots: arrayUnion(...revealedSlots(incoming)),
            });
          return action;
        });
        result[change]++;
        onProgress?.(result.added + result.skipped + result.updated, readings.length);
      }
      return result;
    })(),
  );
