import {
  arrayUnion,
  collection,
  doc,
  documentId,
  getDocFromCache,
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
  where,
  waitForPendingWrites,
  type DocumentSnapshot,
  type Firestore,
} from 'firebase/firestore';
import {
  createJournalBackup,
  findImportTarget,
  mergeReveals,
  UncheckedDeletionsExportError,
  resolveImportReading,
  sameReadingContent,
} from '../domain/journalBackup';
import { isReading } from '../domain/storage';
import {
  authoritativeRecoveryCopies,
  loadRecoveryCopies,
  importTargetRecorder,
  type RecoveryCopy,
} from '../domain/readingRecovery';
import type { Reading } from '../domain/types';
import {
  databaseFor,
  isOfflineJournalEnabled,
  requireVerifiedAccount,
  settledWrites,
  trackWrite,
} from './account';
import {
  checkClearRegistration,
  checkDeletionsForExport,
  checkExportReservations,
  checkReadingsForPendingDeletions,
  enqueueDeletion,
  observeDeletions,
  waitForDeletionBeforeImport,
  type DeletionListener,
} from './deletionQueue';
import { clearRegistrationName, reserveVolatileDeletion } from './deletionReservation';
export { checkReadingsForPendingDeletions };

export {
  isJournalLocked,
  isJournalLockedInThisTabOnly,
  isOfflineJournalEnabled,
  lockJournal,
  observeAccount,
  observeJournalLock,
  refreshAccount,
  resetLockedJournalPassword,
  resetPassword,
  sendVerification,
  signIn,
  signOutAccount,
  signUp,
  unlockJournal,
  type JournalUser,
} from './account';

const readingsFor = (database: Firestore, uid: string) =>
  collection(database, 'users', uid, 'readings');
const clearFor = (database: Firestore, uid: string) =>
  doc(database, 'users', uid, 'journalOperations', 'clear');

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

const readingIdentityFields = (reading: Reading) => ({
  id: reading.id,
  question: reading.question,
  createdAtMs: Date.parse(reading.createdAt),
  cardIds: reading.cards.map(({ cardId }) => cardId),
  orientations: reading.cards.map(({ orientation }) => orientation),
});

const encodeReading = (reading: Reading) => ({
  ...readingIdentityFields(reading),
  createdAt: reading.createdAt,
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

// Collision resolution occasionally needs a document outside the observed page.
export const lookupRecoveryReading = async (uid: string, id: string) => {
  const reference = await readingRef(await databaseFor(uid), uid, id);
  requireVerifiedAccount(uid);
  const snapshot = navigator.onLine
    ? await getDocFromServer(reference)
    : await getDocFromCache(reference);
  requireVerifiedAccount(uid);
  if (snapshot.metadata.hasPendingWrites || (!snapshot.exists() && snapshot.metadata.fromCache)) {
    throw new Error(
      'Reconnect and finish syncing to verify recovery copies for this imported reading.',
    );
  }
  return snapshot.exists() ? decodeReading(snapshot) : undefined;
};

const listen = (
  uid: string,
  subscribe: (database: Firestore, active: () => boolean) => Promise<() => void> | (() => void),
  onError: (error: Error) => void,
): (() => void) => {
  try {
    requireVerifiedAccount(uid);
  } catch (error) {
    onError(error as Error);
    return () => {};
  }
  let cancelled = false;
  let stop: (() => void) | undefined;
  const active = () => {
    if (cancelled) return false;
    try {
      requireVerifiedAccount(uid);
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
      if (!active()) return;
      if (error instanceof Error && /FIRESTORE .*INTERNAL ASSERTION FAILED/i.test(error.message)) {
        onError(
          new Error(
            'Journal sync stopped in this tab. Download any unsynced readings, allow browser storage, and reload the app to reconnect.',
          ),
        );
      } else {
        onError(error instanceof Error ? error : new Error('Could not open this journal.'));
      }
    }
  })();
  return () => {
    cancelled = true;
    try {
      stop?.();
    } catch {
      // Firestore's multi-tab client can throw on unsubscribe after browser
      // storage becomes read-only. The cancelled listener is already gated.
    }
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
    requireVerifiedAccount(uid);
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

export const revealCards = (uid: string, reading: Reading, indexes: number[]) =>
  withReading(uid, reading.id, (reference) =>
    // Firestore rules allow only revealedSlots to change. Including the original
    // identity makes the server reject a queued update if this ID was reused.
    updateDoc(reference, {
      ...readingIdentityFields(reading),
      revealedSlots: arrayUnion(...indexes),
    }),
  );

const deletionClient = (uid: string, trusted: boolean) => {
  const requireSession = () => {
    requireVerifiedAccount(uid);
    if (isOfflineJournalEnabled(uid) !== trusted)
      throw new Error('Return to the original journal session to finish this deletion.');
  };
  return {
    ownerIsCurrent: () => {
      try {
        requireSession();
        return true;
      } catch {
        return false;
      }
    },
    process: async (reading: Reading, claim: () => Promise<boolean>) => {
      // Include earlier creates and reveals that are still hashing their document
      // IDs, then wait for their server acknowledgements before the transaction.
      await dispatches.get(uid);
      requireSession();
      const database = await databaseFor(uid);
      await waitForPendingWrites(database);
      const reference = await readingRef(database, uid, reading.id);
      // A lost commit response can mean the deletion already happened. Let
      // the queue retry in verification mode before touching this document again.
      await runTransaction(
        database,
        async (transaction) => {
          requireSession();
          const current = await transaction.get(reference);
          requireSession();
          const mayDelete = await claim();
          requireSession();
          if (!current.exists()) return;
          const saved = decodeReading(current);
          if (saved.id !== reading.id || !sameReadingContent(saved, reading))
            throw new Error('A different reading now has this ID. Review it and confirm again.');
          if (!mayDelete)
            throw new Error(
              'The previous deletion could not be confirmed. Review the reading and confirm again.',
            );
          transaction.delete(reference);
        },
        { maxAttempts: 1 },
      );
    },
  };
};

export const removeReading = (uid: string, reading: Reading) => {
  requireVerifiedAccount(uid);
  const trusted = isOfflineJournalEnabled(uid);
  return enqueueDeletion(uid, reading, trusted, deletionClient(uid, trusted));
};

export const observePendingDeletions = (uid: string, listener: DeletionListener) => {
  const trusted = isOfflineJournalEnabled(uid);
  const client = deletionClient(uid, trusted);
  if (!client.ownerIsCurrent()) {
    listener([]);
    return () => {};
  }
  return observeDeletions(uid, trusted, client, (requests, error, storageUnreadable) => {
    if (client.ownerIsCurrent()) listener(requests, error, storageUnreadable);
    else listener([]);
  });
};

export const readDeletionTarget = async (uid: string, id: string) => {
  await dispatches.get(uid);
  const database = await onlineDatabase(uid);
  const reference = await readingRef(database, uid, id);
  // A locally deleted row can disappear from a query without that query
  // reporting pending writes. Transaction reads always check the server.
  return runTransaction(database, async (transaction) => {
    requireVerifiedAccount(uid);
    const current = await transaction.get(reference);
    requireVerifiedAccount(uid);
    return current.exists() ? decodeReading(current) : undefined;
  });
};

const pageSize = 100;
const onlineDatabase = async (uid: string) => {
  if (!navigator.onLine)
    throw new Error('Connect to the internet to access your complete account journal.');
  const database = await databaseFor(uid);
  await settledWrites(database);
  requireVerifiedAccount(uid);
  return database;
};
const readPage = async (database: Firestore, uid: string, cursor: string | null) => {
  requireVerifiedAccount(uid);
  const source = query(readingsFor(database, uid), orderBy(documentId()));
  const page = await getDocsFromServer(
    cursor ? query(source, startAfter(cursor), limit(pageSize)) : query(source, limit(pageSize)),
  );
  requireVerifiedAccount(uid);
  if (page.metadata.hasPendingWrites)
    throw new Error('Wait for your journal to finish syncing, then try again.');
  return page;
};
export const exportAccountJournal = async (
  uid: string,
  allowUncheckedDeletions = false,
): Promise<string> => {
  requireVerifiedAccount(uid);
  const trusted = isOfflineJournalEnabled(uid);
  await checkDeletionsForExport(uid, trusted, allowUncheckedDeletions);
  const database = await onlineDatabase(uid);
  const checkedRevision = async () => {
    if (allowUncheckedDeletions) return;
    const clear = await getDocFromServer(clearFor(database, uid));
    requireVerifiedAccount(uid);
    if (clear.get('active') === true)
      throw new UncheckedDeletionsExportError(
        'Clear History may still delete readings from this account. Retry Export journal after the clear finishes, or choose Export available readings for a backup that may include those readings.',
      );
    return clear.get('token') as string | undefined;
  };
  const startingRevision = await checkedRevision();
  const reservations: string[] = [];
  const backup = await createJournalBackup(async (cursor) => {
    const page = await readPage(database, uid, cursor);
    const readings = page.docs.map(decodeReading);
    const names = await checkReadingsForPendingDeletions(
      uid,
      readings.map(({ id }) => id),
      allowUncheckedDeletions,
    );
    reservations.push(...names);
    return {
      readings,
      nextCursor: page.size === pageSize ? page.docs[page.size - 1].id : null,
    };
  });
  requireVerifiedAccount(uid);
  await checkDeletionsForExport(uid, trusted, allowUncheckedDeletions);
  await checkExportReservations(reservations, allowUncheckedDeletions);
  if ((await checkedRevision()) !== startingRevision)
    throw new Error(
      'The journal changed while the backup was being prepared. Choose Export journal again.',
    );
  requireVerifiedAccount(uid);
  return backup;
};

type SubmitClear = (onPageSubmitted?: () => void) => Promise<void>;

const clearChanged =
  'The journal changed while it was clearing. Review the remaining readings and confirm again.';
const reportClearConflict = (error: unknown): never => {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'aborted' ||
      error.code === 'failed-precondition' ||
      error.code === 'already-exists')
  )
    throw new Error(clearChanged);
  throw error;
};

// A confirmed import can cancel a clear even after the clearing tab closes.
// Each delete page verifies the control document in the same server transaction.
const submitClear = async (
  database: Firestore,
  uid: string,
  token: string,
  onPageSubmitted?: () => void,
) => {
  const control = clearFor(database, uid);
  let cursor: string | null = null;
  do {
    const page = await readPage(database, uid, cursor);
    const lastPage = page.size < pageSize;
    await runTransaction(
      database,
      async (transaction) => {
        requireVerifiedAccount(uid);
        const active = await transaction.get(control);
        if (active.get('token') !== token || active.get('active') !== true)
          throw new Error(clearChanged);
        const current = await Promise.all(page.docs.map((entry) => transaction.get(entry.ref)));
        requireVerifiedAccount(uid);
        for (const [index, entry] of current.entries()) {
          if (!entry.exists()) continue;
          if (!sameReadingContent(decodeReading(entry), decodeReading(page.docs[index])))
            throw new Error(
              'A reading changed while the journal was clearing. Review it and confirm again.',
            );
          transaction.delete(entry.ref);
        }
        if (lastPage) transaction.set(control, { token, active: false });
        // From here the server may commit this page even if its response is lost.
        if (!page.empty) onPageSubmitted?.();
      },
      { maxAttempts: 1 },
    ).catch(reportClearConflict);
    cursor = lastPage ? null : page.docs[page.size - 1].id;
  } while (cursor !== null);
};

// Publish the confirmation before resolving local recovery targets. The browser
// reservation covers same-browser recovery until the server has acknowledged it.
export const withClearPreparation = (
  uid: string,
  prepare: (submit: SubmitClear) => Promise<void>,
) =>
  trackWrite(
    uid,
    (async () => {
      requireVerifiedAccount(uid);
      if (!navigator.onLine)
        throw new Error('Connect to the internet to clear your account journal.');
      const token = crypto.randomUUID();
      const release = await reserveVolatileDeletion(clearRegistrationName(uid)).catch(() => {
        throw new Error(
          'This browser could not register the clear with other tabs. Restore browser storage access and confirm again.',
        );
      });
      let database: Firestore;
      try {
        database = await onlineDatabase(uid);
        const control = clearFor(database, uid);
        await runTransaction(
          database,
          async (transaction) => {
            await transaction.get(control);
            requireVerifiedAccount(uid);
            transaction.set(control, { token, active: true });
          },
          { maxAttempts: 1 },
        ).catch(reportClearConflict);
      } finally {
        release();
      }
      try {
        await prepare((onPageSubmitted) => submitClear(database, uid, token, onPageSubmitted));
      } catch (error) {
        // Staging can fail before a delete is sent. Retire only this clear, even
        // if a sibling has since recovered a reading or started a different clear.
        try {
          requireVerifiedAccount(uid);
          const control = clearFor(database, uid);
          await runTransaction(
            database,
            async (transaction) => {
              const current = await transaction.get(control);
              requireVerifiedAccount(uid);
              if (current.get('active') === true && current.get('token') === token)
                transaction.set(control, { token, active: false });
            },
            { maxAttempts: 1 },
          );
        } catch {
          // A lost connection can leave an active token. A future import or
          // fresh explicit clear replaces it without replaying these deletes.
        }
        throw error;
      }
    })(),
  );

export const clearReadings = (uid: string, onPageSubmitted?: () => void) =>
  withClearPreparation(uid, (submit) => submit(onPageSubmitted));

type ImportResult = {
  added: number;
  updated: number;
  skipped: number;
  uncheckedDeletions?: boolean;
};
const emptyResult = (): ImportResult => ({ added: 0, updated: 0, skipped: 0 });
const importChange = (existing: Reading | undefined, incoming: Reading) => {
  if (!existing) return 'added';
  return mergeReveals(existing, incoming) === existing ? 'skipped' : 'updated';
};

type ImportProgress = (completed: number, total: number) => void;
export const lookupRecoveryImportTarget = async (uid: string, source: Reading) => {
  const database = await onlineDatabase(uid);
  const snapshot = await getDocsFromServer(
    query(readingsFor(database, uid), where('createdAtMs', '==', Date.parse(source.createdAt))),
  );
  requireVerifiedAccount(uid);
  return findImportTarget(
    source,
    snapshot.docs
      .filter((doc) => typeof doc.get('id') === 'string' && doc.get('id').startsWith('import-'))
      .map(decodeReading),
    true,
  );
};
const knownImportTarget = (copies: RecoveryCopy[], source: Reading) =>
  copies.find(
    (copy) =>
      copy.importedAs && copy.reading.id === source.id && sameReadingContent(copy.reading, source),
  )?.importedAs;

// Resolve gaps left by a deleted collision occupant, including on another device
// without this browser's local receipt. The transaction rereads the selected ID.
const accountImportResolver = (
  database: Firestore,
  uid: string,
  incoming: Reading[],
  copies: RecoveryCopy[],
  onUnchecked: () => void,
) => {
  const dates = Array.from(new Set(incoming.map((r) => Date.parse(r.createdAt))));
  const groupByDate = new Map(dates.map((date, i) => [date, Math.floor(i / 30)]));
  const explicitIds = new Set(incoming.map((reading) => reading.id));
  const candidates = new Map<number, Promise<Reading[]>>();
  const trusted = isOfflineJournalEnabled(uid);
  const client = deletionClient(uid, trusted);
  return async (source: Reading, lookup: (id: string) => Promise<Reading | undefined>) => {
    await checkClearRegistration(uid, onUnchecked);
    const lookupAfterDeletion = async (id: string) => {
      await waitForDeletionBeforeImport(uid, trusted, id, client, onUnchecked);
      requireVerifiedAccount(uid);
      if (isOfflineJournalEnabled(uid) !== trusted)
        throw new Error('The journal session changed. Review the import and try again.');
      return lookup(id);
    };
    const result = await resolveImportReading(
      source,
      lookupAfterDeletion,
      knownImportTarget(copies, source),
      explicitIds,
    );
    // Recovery already names its assigned document. A same-date legacy copy
    // with unrelated provenance must not prevent restoring a missing target.
    if (
      result.existing ||
      copies.some(
        (copy) => copy.importedAs === source.id && sameReadingContent(copy.reading, source),
      )
    )
      return result;
    const group = groupByDate.get(Date.parse(source.createdAt))!;
    if (!candidates.has(group)) {
      const matchingDates = dates.slice(group * 30, (group + 1) * 30);
      candidates.set(
        group,
        getDocsFromServer(
          query(readingsFor(database, uid), where('createdAtMs', 'in', matchingDates)),
        ).then((snapshot) =>
          snapshot.docs
            .filter(
              (doc) => typeof doc.get('id') === 'string' && doc.get('id').startsWith('import-'),
            )
            .map(decodeReading),
        ),
      );
    }
    const previousId = await findImportTarget(
      source,
      await candidates.get(group)!,
      true,
      explicitIds,
    );
    return previousId
      ? resolveImportReading(source, lookupAfterDeletion, previousId, explicitIds)
      : result;
  };
};
export const previewAccountImport = async (
  uid: string,
  readings: Reading[],
  onProgress?: ImportProgress,
): Promise<ImportResult> => {
  const database = await onlineDatabase(uid);
  const copies = authoritativeRecoveryCopies(loadRecoveryCopies(uid).copies);
  const known = new Map<string, Reading | undefined>();
  const result = emptyResult();
  const resolve = accountImportResolver(database, uid, readings, copies, () => {
    result.uncheckedDeletions = true;
  });
  for (const incoming of readings) {
    requireVerifiedAccount(uid);
    const { id, existing } = await resolve(incoming, async (id) => {
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
  requireVerifiedAccount(uid);
  return result;
};

export const importAccountReadings = (
  uid: string,
  readings: Reading[],
  onProgress?: ImportProgress,
  allowUncheckedDeletions = false,
  retainedCopies?: RecoveryCopy[],
  recovering = false,
) =>
  trackWrite(
    uid,
    (async () => {
      const database = await onlineDatabase(uid);
      const result = emptyResult();
      const control = clearFor(database, uid);
      // A fresh inventory alone can omit a retained copy if storage becomes
      // unreadable between confirmation and the transaction.
      const copies = retainedCopies
        ? retainedCopies.map((copy) => ({ ...copy }))
        : authoritativeRecoveryCopies(loadRecoveryCopies(uid).copies);
      const resolve = accountImportResolver(database, uid, readings, copies, () => {
        if (!allowUncheckedDeletions)
          throw new Error(
            'Saved deletions could not be checked. Review the import again to continue.',
          );
        result.uncheckedDeletions = true;
      });
      for (const incoming of readings) {
        const recordTarget = importTargetRecorder(copies, incoming, retainedCopies !== undefined);
        const change = await runTransaction(database, async (transaction) => {
          requireVerifiedAccount(uid);
          const lookup = async (id: string) => {
            const snapshot = await transaction.get(await readingRef(database, uid, id));
            return snapshot.exists() ? decodeReading(snapshot) : undefined;
          };
          const { id, existing } = await resolve(incoming, lookup);
          requireVerifiedAccount(uid);
          const action = importChange(existing, incoming);
          const reference = await readingRef(database, uid, id);
          requireVerifiedAccount(uid);
          const clear = await transaction.get(control);
          requireVerifiedAccount(uid);
          await recordTarget(id);
          requireVerifiedAccount(uid);
          // Even a skipped import can retire its last recovery copy. Order
          // that confirmation against every page of an earlier clear.
          // Persist an idle revision on recovery. A registration that already
          // observed a missing or older document cannot start after this commit.
          if (recovering || retainedCopies || clear.get('active') === true)
            transaction.set(control, { token: crypto.randomUUID(), active: false });
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
