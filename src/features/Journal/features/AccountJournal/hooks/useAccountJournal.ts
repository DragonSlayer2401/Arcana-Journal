import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { isOfflineJournalEnabled } from '@/services/Account/account.service';
import {
  withClearPreparation,
  createReading,
  lookupRecoveryImportTarget,
  lookupRecoveryReading,
  observePendingDeletions,
  observeReading,
  observeReadings,
  readDeletionTarget,
  removeReading,
  revealCards,
  type AccountClearReview,
  type JournalSyncState,
} from '@/services/Journal/journal.service';
import type { Reading } from '@/features/Journal/readingTypes';
import type { PendingDeletion } from '@/services/Journal/Deletions/deletionQueue';
import { holdJournalEdits, holdRecoveryActivity } from '@/services/Journal/journalActivity';
import {
  findImportTarget,
  mergeReveals,
  resolveImportReading,
} from '@/features/Journal/utils/journalBackup';
import { sameReadingContent } from '@/features/Journal/utils/readingIdentity';
import {
  hasTabRecoveryCopies,
  isTabRecoveryKey,
  saveTabRecoveryCopy,
  tabRecoveryEvent,
} from '../utils/tabRecovery';
import {
  combineReadingCopies,
  containsRecoveryCopy,
  hasRecoveryCopy,
  isPreparedCopy,
  authoritativeRecoveryCopies,
  isRetainedRecoveryCopy,
  recoveryKeysForCopy,
  loadRecoveryCopies,
  prepareRecoveryDeletion,
  isRecoveryStorageKey,
  recoveryReadingLookup,
  resolvedRecoveryCopies,
  retainRecoveryCopies,
  removeRecoveryCopies,
  saveRecoveryCopy,
  type RecoveryCopy,
} from '../utils/readingRecovery';

const historyPageSize = 50;
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : 'Please try again.';
const sameDeletionTarget = (left: Reading, right: Reading) =>
  left.id === right.id && sameReadingContent(left, right);

interface UnsavedDraw {
  reading: Reading;
  error: string;
}

interface PendingWrite {
  key: string | null;
  reading?: Reading;
  deletion?: Reading;
  tabBackup?: string;
}

interface FailedReveal {
  reading: Reading;
  indexes: Set<number>;
  error: string;
}

interface ConfirmedLocalClear {
  recoveryKeys: Set<string>;
  drafts: Map<UnsavedDraw, Reading>;
  failedReveals: Map<FailedReveal, Reading>;
  submit: (onPageSubmitted: () => void) => Promise<void>;
}

// Mounted separately for each account, so a late response cannot replace another user's journal.
export const useAccountJournal = (
  uid: string | undefined,
  activeId: string | null,
  locked = false,
) => {
  const [limit, setLimit] = useState(historyPageSize);
  const [readings, setReadings] = useState<Reading[]>([]);
  const [snapshot, setSnapshot] = useState<JournalSyncState>({
    fromCache: true,
    pending: false,
    hasMore: false,
  });
  const [received, setReceived] = useState(false);
  const [selected, setSelected] = useState<{ id: string; value: Reading | null } | null>(null);
  const drafts = useRef(new Map<string, UnsavedDraw>()).current;
  const failedReveals = useRef(new Set<FailedReveal>()).current;
  const failedRevealFor = (reading: Reading) =>
    Array.from(failedReveals).find(
      (failed) => failed.reading.id === reading.id && sameReadingContent(failed.reading, reading),
    );
  const clearFailedReveal = (reading: Reading) => {
    const failed = failedRevealFor(reading);
    if (failed) failedReveals.delete(failed);
  };
  const [revision, refreshWrites] = useReducer((version: number) => version + 1, 0);
  const writes = useRef(new Set<PendingWrite>()).current;
  const deleting = useRef(new Set<Reading>()).current;
  const hiddenDeletions = useRef(new Map<Reading, 'pending' | 'committed'>()).current;
  const deletingKeys = useRef(new Set<string>()).current;
  const verifiedRecovery = useRef(new Set<string>()).current;
  const releaseEditLock = useRef<(() => void) | null>(null);
  const releaseBackupLock = useRef<(() => void) | null>(null);
  const [readError, setReadError] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [deletionSyncError, setDeletionSyncError] = useState('');
  const [queuedDeletions, setQueuedDeletions] = useState<PendingDeletion[]>([]);
  const [deletionStorageUnreadable, setDeletionStorageUnreadable] = useState<boolean>();
  const [retry, setRetry] = useState(0);
  const trusted = uid ? isOfflineJournalEnabled(uid) : false;
  useEffect(() => {
    if (!uid) return;
    let previous: PendingDeletion[] = [];
    return observePendingDeletions(uid, (requests, error, storageUnreadable) => {
      setQueuedDeletions(requests);
      setDeletionStorageUnreadable(storageUnreadable);
      // A replay can delete a reading outside the observed page. Refresh its
      // staged copies even when that page has no changed rows to report.
      if (requests.length < previous.length) {
        // Locally initiated requests also wait for their draft cleanup below.
        const replayed = previous.filter(
          (request) =>
            !requests.some(({ key }) => key === request.key) &&
            hiddenDeletions.get(request.reading) !== 'pending',
        );
        if (!error) replayed.forEach(({ reading }) => hiddenDeletions.set(reading, 'committed'));
        if (error || replayed.length) setRetry((value) => value + 1);
        setDeletionSyncError('');
        if (error) setDeleteError(error);
      } else if (error) setDeletionSyncError(error);
      previous = requests;
    });
  }, [uid, trusted, retry, hiddenDeletions]);
  const inventory = useMemo(
    () =>
      uid && !locked
        ? loadRecoveryCopies(uid)
        : { copies: [], pendingCleanup: [], prepared: [], complete: true },
    [uid, revision, retry, locked],
  );
  const pendingRemoval = useRef(new Set<string>()).current;
  // Retry only these immutable keys. A later reading in another tab can share
  // the same legacy reading ID without sharing its recovery key.
  const discardCopies = useCallback(
    (keys: string[]) => {
      if (!keys.length) return;
      const { remaining } = removeRecoveryCopies(keys);
      for (const key of keys) {
        if (remaining.has(key)) pendingRemoval.add(key);
        else pendingRemoval.delete(key);
      }
      refreshWrites();
    },
    [pendingRemoval],
  );
  useEffect(() => {
    if (!uid) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || isRecoveryStorageKey(uid, event.key)) {
        if (event.key && event.newValue === null) pendingRemoval.delete(event.key);
        refreshWrites();
      }
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener(tabRecoveryEvent(uid), refreshWrites);
    window.addEventListener('focus', refreshWrites);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(tabRecoveryEvent(uid), refreshWrites);
      window.removeEventListener('focus', refreshWrites);
    };
  }, [uid, pendingRemoval]);

  useEffect(() => {
    if (!uid || locked) return;
    let live = true;
    let snapshotVersion = 0;
    // This subscription starts after these deletions finished. Its cached
    // rows can be stale, but its first settled server result can show even an
    // identical reading that was deliberately imported again.
    const completedBeforeSubscribe = Array.from(hiddenDeletions)
      .filter(([, stage]) => stage === 'committed')
      .map(([reading]) => reading);
    const stop = observeReadings(
      uid,
      limit,
      (entries, state) => {
        if (!live) return;
        const version = ++snapshotVersion;
        // A tab can close after a server commit but before deleting its recovery
        // copy. A fresh, acknowledged server snapshot can retire that exact copy.
        if (!state.fromCache && !state.pending) {
          if (completedBeforeSubscribe.length) {
            const completed = completedBeforeSubscribe.splice(0);
            completed.forEach((reading) => hiddenDeletions.delete(reading));
            setSelected((current) => {
              const reading = current?.value;
              return reading && completed.some((target) => sameDeletionTarget(target, reading))
                ? null
                : current;
            });
          }
          const { copies, prepared } = loadRecoveryCopies(uid);
          verifiedRecovery.clear();
          const lookupMissing = state.hasMore
            ? (id: string) => lookupRecoveryReading(uid, id)
            : undefined;
          const confirmedTargets = recoveryReadingLookup([], (id) => readDeletionTarget(uid, id));
          for (const copy of prepared) {
            if (deletingKeys.has(copy.key)) continue;
            void (async () => {
              const remote =
                copy.targetId === null ? undefined : await confirmedTargets(copy.targetId);
              if (
                !live ||
                version !== snapshotVersion ||
                deletingKeys.has(copy.key) ||
                !isPreparedCopy(copy)
              )
                return;
              // A locally-only copy has no server deletion to acknowledge after
              // an interrupted clear. Preserve it for the owner's next decision.
              if (
                copy.targetId === null ||
                (remote &&
                  (!sameReadingContent(remote, copy.reading) ||
                    copy.reading.revealed.some((shown, index) => shown && !remote.revealed[index])))
              ) {
                // Another tab may still commit the original request. Keep the
                // durable target so the next snapshot or reload checks it again.
                verifiedRecovery.add(copy.key);
                refreshWrites();
              } else discardCopies(recoveryKeysForCopy(copy.key));
            })().catch((error) => {
              if (live) setReadError(messageOf(error));
            });
          }
          const automatic = copies.filter(({ key }) => !isRetainedRecoveryCopy(key));
          void resolvedRecoveryCopies(automatic, entries, entries, true, lookupMissing)
            .then((confirmed) => {
              if (!live || version !== snapshotVersion) return;
              discardCopies(
                confirmed
                  .filter(({ key, reading, importedAs }) =>
                    hasRecoveryCopy(key, reading, importedAs),
                  )
                  .map(({ key }) => key),
              );
            })
            .catch((error) => {
              if (live) setReadError(messageOf(error));
            });
          refreshWrites(); // Storage permissions may have changed since the last render.
        }
        setReceived(true);
        setReadings(entries);
        setSnapshot(state);
      },
      (error) => {
        if (live) setReadError(error.message);
      },
    );
    return () => {
      live = false;
      stop();
    };
  }, [uid, limit, retry, locked, discardCopies, deletingKeys, verifiedRecovery, hiddenDeletions]);

  // An older active spread can fall outside the journal's current page.
  const listed = readings.find((entry) => entry.id === activeId);
  const watchId = listed ? null : activeId;
  useEffect(() => {
    if (!uid || locked || !watchId) return;
    let live = true;
    const stop = observeReading(
      uid,
      watchId,
      (value) => {
        if (live) setSelected({ id: watchId, value });
      },
      (error) => {
        if (live) setReadError(error.message);
      },
    );
    return () => {
      live = false;
      stop();
    };
  }, [uid, watchId, retry, locked]);

  const trackWrite = async (
    operation: () => Promise<unknown>,
    reading?: Reading,
    deletion?: Reading,
  ) => {
    if (uid) releaseBackupLock.current ??= holdRecoveryActivity(uid);
    if (uid && trusted) releaseEditLock.current ??= holdJournalEdits(uid);
    const key = uid && trusted && reading ? saveRecoveryCopy(uid, reading) : null;
    const write: PendingWrite = { key, reading, deletion };
    writes.add(write);
    refreshWrites();
    try {
      await operation();
      if (key && reading && hasRecoveryCopy(key, reading)) discardCopies([key]);
      if (write.tabBackup && reading && hasRecoveryCopy(write.tabBackup, reading))
        discardCopies([write.tabBackup]);
    } finally {
      writes.delete(write);
      refreshWrites();
    }
  };

  const saveDraw = (reading: Reading) => {
    if (!uid) return;
    const draft: UnsavedDraw = { reading, error: '' };
    drafts.set(reading.id, draft);
    // A retried create already includes the reveal progress kept in this draft.
    clearFailedReveal(reading);
    void trackWrite(() => createReading(uid, reading), reading)
      .then(() => {
        if (drafts.get(reading.id) === draft) drafts.delete(reading.id);
      })
      .catch((error) => {
        draft.error = messageOf(error);
        clearFailedReveal(reading);
      })
      .finally(refreshWrites);
  };

  const keepRevealForRecovery = (owner: string, reading: Reading) => {
    const { copies } = loadRecoveryCopies(owner);
    if (!copies.some((copy) => containsRecoveryCopy(copy, reading))) {
      if (trusted) saveRecoveryCopy(owner, reading);
      else saveTabRecoveryCopy(owner, reading);
    }
    clearFailedReveal(reading);
    refreshWrites();
  };

  const reveal = (id: string, indexes: number[], original?: Reading) => {
    if (!uid) return;
    const draft = drafts.get(id);
    const displayed = original ?? findReading(id) ?? draft?.reading;
    if (!displayed) return;
    const editingDraft = draft && sameReadingContent(draft.reading, displayed);
    const source = editingDraft ? draft.reading : displayed;
    const updated = {
      ...source,
      revealed: source.revealed.map((shown, i) => shown || indexes.includes(i)),
    };
    if (editingDraft) {
      draft.reading = updated;
      refreshWrites();
      if (draft.error) {
        if (trusted) saveRecoveryCopy(uid, updated);
        return;
      }
    }
    // The cloud client dispatches this update after any earlier create for the same account.
    void trackWrite(() => revealCards(uid, source, indexes), updated)
      .then(() => {
        const failed = failedRevealFor(updated);
        if (!failed) return;
        indexes.forEach((slot) => failed.indexes.delete(slot));
        if (failed.indexes.size === 0) failedReveals.delete(failed);
        refreshWrites();
      })
      .catch((error) => {
        if (editingDraft && draft.error) return;
        if (error && typeof error === 'object' && error.code === 'not-found') {
          clearFailedReveal(updated);
          const deleted = loadRecoveryCopies(uid).copies.filter(
            ({ key, reading, importedAs }) =>
              !isRetainedRecoveryCopy(key) &&
              !importedAs &&
              reading.id === id &&
              sameReadingContent(reading, updated),
          );
          discardCopies(deleted.map(({ key }) => key));
        } else if (error && typeof error === 'object' && error.code === 'permission-denied') {
          // This can mean that a different spread now occupies this ID. Use
          // the normal collision-aware recovery preview for the original.
          const previous = failedRevealFor(updated);
          keepRevealForRecovery(uid, previous ? mergeReveals(updated, previous.reading) : updated);
        } else {
          const failed = failedRevealFor(updated) ?? {
            reading: updated,
            indexes: new Set<number>(),
            error: '',
          };
          indexes.forEach((index) => failed.indexes.add(index));
          failed.reading = mergeReveals(updated, failed.reading);
          failed.error = messageOf(error);
          failedReveals.add(failed);
        }
        refreshWrites();
      });
  };

  const removeConfirmed = async (
    id: string | undefined,
    confirmedReading?: Reading,
    clear?: ConfirmedLocalClear,
  ) => {
    if (!uid) return;
    setDeleteError('');
    const displayed = findReading(id);
    const target = confirmedReading ?? displayed;
    if (
      id !== undefined &&
      (!target || target.id !== id || (displayed && !sameReadingContent(displayed, target)))
    ) {
      const message = 'This reading changed. Review the journal and confirm again.';
      setDeleteError(message);
      throw new Error(message);
    }
    const latest = loadRecoveryCopies(uid);
    const copies = availableCopies(latest);
    if (
      !latest.complete ||
      latest.prepared.some(
        ({ key, targetId }) => !verifiedRecovery.has(key) && (id === undefined || targetId === id),
      )
    ) {
      const message = !latest.complete
        ? 'Deletion could not start because this browser could not check every recovery copy. Allow browser storage, then choose the readings and confirm again.'
        : 'Reconnect and choose Retry sync to finish checking the earlier deletion, then confirm this deletion again.';
      setDeleteError(message);
      throw new Error(message);
    }
    let keys: string[];
    let restore: () => void;
    if (target) {
      hiddenDeletions.set(target, 'pending');
      refreshWrites();
    }
    try {
      let matched = clear ? copies.filter(({ key }) => clear.recoveryKeys.has(key)) : copies;
      if (id !== undefined) {
        if (target && id.startsWith('import-')) {
          matched = await resolvedRecoveryCopies(
            copies,
            [...readings, target],
            [target],
            false,
            snapshot.hasMore || snapshot.fromCache
              ? (key) => lookupRecoveryReading(uid, key)
              : undefined,
          );
        } else {
          matched = copies.filter(
            ({ importedAs, reading }) =>
              target && (importedAs ?? reading.id) === id && sameReadingContent(reading, target),
          );
        }
      }
      const lookup = recoveryReadingLookup(
        readings,
        snapshot.hasMore || snapshot.fromCache
          ? (key) => lookupRecoveryReading(uid, key)
          : undefined,
      );
      const staged =
        id === undefined
          ? await Promise.all(
              matched.map(async (copy) => {
                if (copy.importedAs) {
                  const assigned = await lookup(copy.importedAs);
                  const targetId =
                    assigned && sameReadingContent(assigned, copy.reading) ? assigned.id : null;
                  return { ...copy, targetId };
                }
                const matched = await resolveImportReading(copy.reading, lookup);
                const targetId =
                  matched.existing?.id ??
                  (snapshot.hasMore || snapshot.fromCache
                    ? await lookupRecoveryImportTarget(uid, copy.reading)
                    : await findImportTarget(copy.reading, readings, true));
                return { ...copy, targetId: targetId ?? null };
              }),
            )
          : matched.map((copy) => ({ ...copy, targetId: id }));
      keys = staged.map(({ key }) => key);
      restore = prepareRecoveryDeletion(staged);
    } catch (error) {
      if (target) hiddenDeletions.delete(target);
      setDeleteError(messageOf(error));
      refreshWrites();
      throw error;
    }
    const draft = id !== undefined ? drafts.get(id) : undefined;
    const matchesDraft = draft && target && sameReadingContent(draft.reading, target);
    // A rejected draw exists only in this session and can be discarded after confirmation.
    if (id !== undefined && matchesDraft && draft.error) {
      hiddenDeletions.delete(target);
      drafts.delete(id);
      clearFailedReveal(draft.reading);
      discardCopies(keys.flatMap(recoveryKeysForCopy));
      refreshWrites();
      return;
    }
    // A confirmed single delete can be queued offline. Withdraw its backup now
    // so closing the tab before acknowledgment cannot offer that reading again.
    if (target) deleting.add(target);
    keys.forEach((key) => deletingKeys.add(key));
    keys.forEach((key) => verifiedRecovery.delete(key));
    let submittedPage = false;
    try {
      await trackWrite(
        () =>
          clear
            ? clear.submit(() => {
                submittedPage = true;
              })
            : removeReading(uid, target!),
        undefined,
        target ?? undefined,
      );
      discardCopies(keys.flatMap(recoveryKeysForCopy));
      if (clear) {
        for (const [draft, confirmed] of clear.drafts) {
          if (draft.error && draft.reading === confirmed && drafts.get(confirmed.id) === draft)
            drafts.delete(confirmed.id);
        }
        for (const [failed, confirmed] of clear.failedReveals) {
          if (failed.reading === confirmed) failedReveals.delete(failed);
        }
      } else if (id !== undefined) {
        if (matchesDraft && drafts.get(id) === draft) drafts.delete(id);
        if (target) {
          clearFailedReveal(target);
          hiddenDeletions.set(target, 'committed');
          setRetry((value) => value + 1);
        }
      }
      refreshWrites();
    } catch (error) {
      if (target) hiddenDeletions.delete(target);
      if (submittedPage) setRetry((value) => value + 1);
      else restore();
      refreshWrites();
      setDeleteError(
        `Deletion did not finish. ${messageOf(error)} Choose the readings to delete and confirm again.`,
      );
      throw error;
    } finally {
      if (target) deleting.delete(target);
      keys.forEach((key) => deletingKeys.delete(key));
    }
  };

  const remove = async (id?: string, reading?: Reading, review?: AccountClearReview) => {
    if (!uid || id !== undefined) return removeConfirmed(id, reading);
    setDeleteError('');
    try {
      const latest = loadRecoveryCopies(uid);
      if (!latest.complete)
        throw new Error(
          'Deletion could not start because this browser could not check every recovery copy. Allow browser storage, then choose the readings and confirm again.',
        );
      const local = {
        recoveryKeys: new Set(availableCopies(latest).map(({ key }) => key)),
        drafts: new Map(Array.from(drafts.values(), (draft) => [draft, draft.reading])),
        failedReveals: new Map(Array.from(failedReveals, (failed) => [failed, failed.reading])),
      };
      await withClearPreparation(
        uid,
        (submit) => removeConfirmed(undefined, undefined, { ...local, submit }),
        review,
      );
    } catch (error) {
      // Registration can fail before the hook starts staging the recovery copies.
      setDeleteError((previous) => previous || messageOf(error));
      throw error;
    }
  };

  const draftReadings = Array.from(drafts.values(), ({ reading }) => reading);
  const pendingWrites = Array.from(writes);
  const activeKeys = new Set(pendingWrites.map(({ key }) => key));
  const availableCopies = (source: typeof inventory) =>
    authoritativeRecoveryCopies(
      [
        ...source.copies,
        ...source.prepared.filter(({ key }) => verifiedRecovery.has(key) && !deletingKeys.has(key)),
      ].filter(({ key }) => !pendingRemoval.has(key)),
      [...source.copies, ...source.prepared, ...source.pendingCleanup],
    );
  const recoveryComplete = (source: typeof inventory) =>
    source.complete &&
    source.prepared.every(({ key }) => verifiedRecovery.has(key) && !deletingKeys.has(key));
  const copies = availableCopies(inventory);
  const savedCopies = copies.filter(({ key, reading }) => {
    const draft = drafts.get(reading.id)?.reading;
    return (
      !activeKeys.has(key) &&
      !(draft && sameReadingContent(draft, reading)) &&
      !failedRevealFor(reading)
    );
  });
  const savedReadings = combineReadingCopies(savedCopies);
  const collectRecoveryReadings = (available: RecoveryCopy[]) =>
    combineReadingCopies([
      ...available,
      ...drafts.values(),
      ...Array.from(writes).flatMap(({ reading }) => (reading ? [{ reading }] : [])),
      ...failedReveals,
    ]);
  const recoveryReadings = collectRecoveryReadings(copies);
  const getRecoveryForExport = () => {
    if (!uid) return { readings: [], complete: true, assignedIds: new Set<string>() };
    // Recheck at download time. Storage access can change while cloud pages are loading.
    const latest = loadRecoveryCopies(uid);
    const available = availableCopies(latest);
    refreshWrites();
    return {
      readings: collectRecoveryReadings(available),
      assignedIds: new Set(available.flatMap(({ importedAs }) => (importedAs ? [importedAs] : []))),
      complete: recoveryComplete(latest),
    };
  };
  const remoteIds = new Set(readings.map(({ id }) => id));
  const extras = draftReadings.filter(({ id }) => !remoteIds.has(id));
  const entries = [
    ...extras,
    ...readings.map((entry) => {
      const draft = drafts.get(entry.id);
      return draft && sameReadingContent(entry, draft.reading)
        ? mergeReveals(entry, draft.reading)
        : entry;
    }),
  ];
  const findReading = (id: string | null | undefined) =>
    entries.find((reading) => reading.id === id) ??
    (selected && selected.id === id ? selected.value : null);
  const hiddenTargets = [
    ...hiddenDeletions.keys(),
    ...queuedDeletions.map(({ reading }) => reading),
  ];
  const isHidden = (reading: Reading) =>
    hiddenTargets.some((target) => sameDeletionTarget(target, reading));
  const selectedReading = findReading(activeId);
  const active = selectedReading && !isHidden(selectedReading) ? selectedReading : null;
  const pending = snapshot.pending || writes.size > 0 || queuedDeletions.length > 0;
  const rejected = Array.from(drafts.values()).filter((draft) => draft.error);
  const rejectedReveal = failedReveals.values().next().value;
  const recoveryReadError = !inventory.complete
    ? 'This browser could not read every recovery copy. Allow browser storage and choose Retry sync to check again.'
    : '';
  const cleanupKeys = new Set([
    ...pendingRemoval,
    ...inventory.pendingCleanup.map(({ key }) => key),
  ]);
  const remainingTitles = [
    ...new Set(
      [...inventory.copies, ...inventory.pendingCleanup]
        .filter(({ key }) => cleanupKeys.has(key))
        .map(({ reading }) => reading.question || 'Untitled reading'),
    ),
  ];
  const cleanupError = cleanupKeys.size
    ? `This browser has ${cleanupKeys.size} recovery ${cleanupKeys.size === 1 ? 'copy' : 'copies'} waiting for removal${remainingTitles.length ? ` (${remainingTitles.join(', ')})` : ''}. Allow storage changes and choose Retry sync to remove the remaining copies.`
    : '';
  const unresolvedDeletion = inventory.prepared.some(
    ({ key }) => !deletingKeys.has(key) && !verifiedRecovery.has(key),
  )
    ? 'Reconnect and choose Retry sync to check recovery copies from an interrupted deletion.'
    : '';
  const syncError = [
    rejected[0]?.error || rejectedReveal?.error || readError,
    recoveryReadError,
    cleanupError,
    unresolvedDeletion,
    deletionSyncError,
  ]
    .filter(Boolean)
    .join(' ');
  const needsOpenTab =
    Boolean(uid && hasTabRecoveryCopies(uid)) ||
    queuedDeletions.some((request) => !request.durable) ||
    pendingWrites.some(({ key, reading, deletion }) =>
      deletion
        ? !queuedDeletions.some((request) => request.durable && request.reading === deletion)
        : !key || isTabRecoveryKey(key) || !reading || !hasRecoveryCopy(key, reading),
    );
  const requiresOpenTab = needsOpenTab || rejected.length > 0 || failedReveals.size > 0;
  useEffect(() => {
    if (!requiresOpenTab) return;
    const beforeClose = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener('beforeunload', beforeClose);
    return () => window.removeEventListener('beforeunload', beforeClose);
  }, [requiresOpenTab]);
  // Acquire on the write event itself, before React renders. Keep a rejected
  // edit protected until the owner retries or explicitly discards it.
  useEffect(() => {
    if (!writes.size && !drafts.size && !failedReveals.size) {
      releaseBackupLock.current?.();
      releaseBackupLock.current = null;
      releaseEditLock.current?.();
      releaseEditLock.current = null;
    }
  }, [revision, writes, drafts, failedReveals]);
  useEffect(() => {
    return () => {
      releaseBackupLock.current?.();
      releaseBackupLock.current = null;
      releaseEditLock.current?.();
      releaseEditLock.current = null;
      if (!uid || !trusted || (!writes.size && !drafts.size && !failedReveals.size)) return;
      // A sibling can sign out on a browser without Web Locks after a backup
      // was removed. Preserve live edits for this owner before React unmounts.
      const { copies, prepared } = loadRecoveryCopies(uid);
      const keep = (reading: Reading) => {
        if (
          prepared.some(
            (copy) =>
              deletingKeys.has(copy.key) &&
              copy.reading.id === reading.id &&
              sameReadingContent(copy.reading, reading),
          ) ||
          Array.from(deleting).some(
            (target) => target.id === reading.id && sameReadingContent(target, reading),
          ) ||
          copies.some((copy) => containsRecoveryCopy(copy, reading))
        )
          return;
        const key = saveTabRecoveryCopy(uid, reading);
        copies.push({ key, reading });
        return key;
      };
      for (const write of writes) {
        if (write.reading) write.tabBackup = keep(write.reading);
      }
      for (const draft of drafts.values()) keep(draft.reading);
      for (const failed of failedReveals) keep(failed.reading);
    };
  }, [uid, trusted, writes, drafts, failedReveals, deleting, deletingKeys]);
  const status = rejected.length
    ? 'A reading still needs to be saved. Keep this tab open or download your unsynced readings.'
    : needsOpenTab
      ? 'Closing this tab could lose unsynced changes. Keep it open until you recover, download, or sync your readings.'
      : syncError
        ? 'Journal sync needs attention.'
        : pending
          ? 'Changes waiting to sync.'
          : !received || (trusted && deletionStorageUnreadable === undefined)
            ? 'Opening your account journal…'
            : snapshot.fromCache
              ? 'Showing the journal available on this device.'
              : deletionStorageUnreadable
                ? 'Cloud readings synced. Saved deletions could not be checked.'
                : 'Journal synced.';

  return {
    entries: entries.filter((entry) => !isHidden(entry)),
    storedReadings: snapshot.storedReadings ?? (received && !snapshot.pending ? readings : null),
    active,
    pending: pending || rejected.length > 0 || failedReveals.size > 0,
    trusted,
    hasFailedWrites: rejected.length > 0 || failedReveals.size > 0,
    saving: writes.size > 0,
    needsOpenTab,
    status:
      savedReadings.length && !syncError && !needsOpenTab
        ? 'This browser has unsynced readings available for recovery.'
        : status,
    syncError,
    deleteError,
    deletionStorageUnreadable,
    recoveryReadings,
    recoveryComplete: recoveryComplete(inventory),
    getRecoveryForExport,
    savedRecovery: {
      readings: savedReadings,
      isCurrent: () => {
        if (!uid) return false;
        const latest = loadRecoveryCopies(uid);
        const currentKeys = new Set(availableCopies(latest).map(({ key }) => key));
        return savedCopies.every(
          ({ key, reading, importedAs }) =>
            currentKeys.has(key) &&
            (hasRecoveryCopy(key, reading, importedAs) ||
              (verifiedRecovery.has(key) &&
                latest.prepared.some((copy) => copy.key === key && isPreparedCopy(copy)))),
        );
      },
      discard: () => discardCopies(savedCopies.flatMap(({ key }) => recoveryKeysForCopy(key))),
      retainUntilChecked: () => {
        if (!uid) throw new Error('The journal account has changed. Please retry.');
        const retained = retainRecoveryCopies(uid, savedCopies);
        refreshWrites();
        return {
          copies: retained,
          discard: () => discardCopies(retained.flatMap(({ key }) => recoveryKeysForCopy(key))),
        };
      },
    },
    isFailedDraw: (id: string) => {
      const draft = drafts.get(id);
      const target = findReading(id);
      return Boolean(draft?.error && target && sameReadingContent(draft.reading, target));
    },
    loadingActive: Boolean(uid && activeId && !active && selected?.id !== activeId && !syncError),
    loading: Boolean(uid && !received && !syncError),
    hasMore: snapshot.hasMore,
    loadMore: () => setLimit((size) => size + historyPageSize),
    retrySync: () => {
      setReadError('');
      setDeletionSyncError('');
      discardCopies([...cleanupKeys].flatMap(recoveryKeysForCopy));
      setRetry((value) => value + 1);
      rejected.forEach(({ reading }) => {
        if (drafts.get(reading.id)?.error) saveDraw(reading);
      });
      for (const failed of Array.from(failedReveals)) {
        const { reading } = failed;
        const current = findReading(reading.id);
        if (uid && current && !sameReadingContent(current, reading)) {
          keepRevealForRecovery(uid, reading);
        } else {
          failedReveals.delete(failed);
          reveal(reading.id, [...failed.indexes], reading);
        }
      }
    },
    saveDraw,
    reveal,
    remove,
  };
};
