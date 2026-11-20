import { useEffect, useReducer, useRef, useState } from 'react';
import {
  clearReadings,
  createReading,
  isOfflineJournalEnabled,
  observeReading,
  observeReadings,
  removeReading,
  revealCards,
} from './cloud/journal';
import type { Reading } from './domain/types';
import { mergeReveals } from './domain/journalBackup';

const PAGE_SIZE = 50;
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : 'Please try again.';

interface UnsavedDraw {
  reading: Reading;
  error: string;
}

// Mounted separately for each account, so a late response cannot replace another user's journal.
export const useAccountJournal = (uid: string | undefined, activeId: string | null) => {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [readings, setReadings] = useState<Reading[]>([]);
  const [snapshot, setSnapshot] = useState({ fromCache: true, pending: false, hasMore: false });
  const [received, setReceived] = useState(false);
  const [selected, setSelected] = useState<{ id: string; value: Reading | null } | null>(null);
  const drafts = useRef(new Map<string, UnsavedDraw>()).current;
  const failedReveals = useRef(new Map<string, { indexes: Set<number>; error: string }>()).current;
  const [, refreshWrites] = useReducer((version: number) => version + 1, 0);
  const [writes, setWrites] = useState(0);
  const [readError, setReadError] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!uid) return;
    let live = true;
    const stop = observeReadings(
      uid,
      limit,
      (entries, state) => {
        if (!live) return;
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
  }, [uid, limit, retry]);

  // An older active spread can fall outside the journal's current page.
  const listed = readings.find((entry) => entry.id === activeId);
  const watchId = listed ? null : activeId;
  useEffect(() => {
    if (!uid || !watchId) return;
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
  }, [uid, watchId, retry]);

  const trackWrite = async (operation: () => Promise<unknown>) => {
    setWrites((count) => count + 1);
    try {
      await operation();
    } finally {
      setWrites((count) => count - 1);
    }
  };

  const saveDraw = (reading: Reading) => {
    if (!uid) return;
    const draft: UnsavedDraw = { reading, error: '' };
    drafts.set(reading.id, draft);
    // A retried create already includes the reveal progress kept in this draft.
    failedReveals.delete(reading.id);
    void trackWrite(() => createReading(uid, reading))
      .then(() => {
        if (drafts.get(reading.id) === draft) drafts.delete(reading.id);
      })
      .catch((error) => {
        draft.error = messageOf(error);
        failedReveals.delete(reading.id);
      })
      .finally(refreshWrites);
  };

  const reveal = (id: string, indexes: number[]) => {
    if (!uid) return;
    const draft = drafts.get(id);
    if (draft) {
      draft.reading = {
        ...draft.reading,
        revealed: draft.reading.revealed.map((shown, i) => shown || indexes.includes(i)),
      };
      refreshWrites();
      if (draft.error) return;
    }
    // The cloud client dispatches this update after any earlier create for the same account.
    void trackWrite(() => revealCards(uid, id, indexes))
      .then(() => {
        const failed = failedReveals.get(id);
        if (!failed) return;
        indexes.forEach((slot) => failed.indexes.delete(slot));
        if (failed.indexes.size === 0) failedReveals.delete(id);
        refreshWrites();
      })
      .catch((error) => {
        if (drafts.get(id)?.error) return;
        if (error && typeof error === 'object' && error.code === 'not-found') {
          failedReveals.delete(id);
        } else {
          const slots = failedReveals.get(id)?.indexes ?? new Set<number>();
          indexes.forEach((i) => slots.add(i));
          failedReveals.set(id, { indexes: slots, error: messageOf(error) });
        }
        refreshWrites();
      });
  };

  const remove = async (id?: string) => {
    if (!uid) return;
    setDeleteError('');
    // A rejected draw exists only in this session and can be discarded after confirmation.
    if (id !== undefined && drafts.get(id)?.error) {
      drafts.delete(id);
      failedReveals.delete(id);
      refreshWrites();
      return;
    }
    const localAtConfirmation = Array.from(drafts.entries());
    try {
      await trackWrite(() => (id === undefined ? clearReadings(uid) : removeReading(uid, id)));
      if (id === undefined) {
        for (const [key, draft] of localAtConfirmation) {
          if (draft.error && drafts.get(key) === draft) drafts.delete(key);
        }
        failedReveals.clear();
      } else {
        drafts.delete(id);
        failedReveals.delete(id);
      }
      refreshWrites();
    } catch (error) {
      setDeleteError(
        `Deletion did not finish. ${messageOf(error)} Choose the readings to delete and confirm again.`,
      );
      throw error;
    }
  };

  const recoveryReadings = Array.from(drafts.values(), ({ reading }) => reading);
  const remoteIds = new Set(readings.map(({ id }) => id));
  const extras = recoveryReadings.filter(({ id }) => !remoteIds.has(id));
  const entries = [
    ...extras,
    ...readings.map((entry) => {
      const draft = drafts.get(entry.id);
      return draft ? mergeReveals(entry, draft.reading) : entry;
    }),
  ];
  const active =
    entries.find(({ id }) => id === activeId) ??
    (selected?.id === activeId ? selected?.value : null);
  const pending = snapshot.pending || writes > 0;
  const trusted = uid ? isOfflineJournalEnabled(uid) : false;
  const rejected = Array.from(drafts.values()).filter((draft) => draft.error);
  const rejectedReveal = failedReveals.values().next().value;
  const syncError = rejected[0]?.error || rejectedReveal?.error || readError;
  const status = rejected.length
    ? 'A reading still needs to be saved. Keep this tab open or download your unsynced readings.'
    : syncError
      ? 'Journal sync needs attention.'
      : pending
        ? trusted
          ? 'Changes waiting to sync.'
          : 'Saving changes. Keep this tab open.'
        : !received
          ? 'Opening your account journal…'
          : snapshot.fromCache
            ? 'Showing the journal available on this device.'
            : 'Journal synced.';

  return {
    entries,
    active,
    pending: pending || rejected.length > 0,
    status,
    syncError,
    deleteError,
    recoveryReadings,
    isFailedDraw: (id: string) => Boolean(drafts.get(id)?.error),
    loadingActive: Boolean(uid && activeId && !active && selected?.id !== activeId && !syncError),
    loading: Boolean(uid && !received && !syncError),
    hasMore: snapshot.hasMore,
    loadMore: () => setLimit((size) => size + PAGE_SIZE),
    retrySync: () => {
      setReadError('');
      setRetry((value) => value + 1);
      rejected.forEach(({ reading }) => {
        if (drafts.get(reading.id)?.error) saveDraw(reading);
      });
      for (const [id, failed] of Array.from(failedReveals)) {
        failedReveals.delete(id);
        reveal(id, [...failed.indexes]);
      }
    },
    saveDraw,
    reveal,
    remove,
  };
};
