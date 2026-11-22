import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { Reading } from '@/features/Journal/readingTypes';
import type { AppData } from '@/features/Journal/utils/journalData';
import { sameReadingContent } from '@/features/Journal/utils/readingIdentity';
import { guestConflictMessage, guestDraftConflicts, type GuestDraft } from '../utils/guestDraft';
import {
  clearGuestHistory,
  guestSaveWarning,
  loadData,
  saveData,
  guestStorageKey,
} from '../utils/guestStorage';
import { waitForGuestWrites, withGuestWrite } from '../utils/guestWrite';

export const guestReadingChanged =
  'This reading changed in another tab. Review the journal and confirm again.';
const guestWriteUnavailable =
  'This browser could not coordinate changes to the guest journal. Your edits are available in this tab. Export a backup before closing it.';

interface GuestSession {
  isGuest: boolean;
  dataRef: RefObject<AppData>;
  setData: Dispatch<SetStateAction<AppData>>;
  drawLocked: RefObject<boolean>;
  guestDraft: RefObject<GuestDraft | null>;
  setWarning: (warning: string) => void;
  invalidateDownloads: () => void;
}

export const useGuestJournal = ({
  isGuest,
  dataRef,
  setData,
  drawLocked,
  guestDraft,
  setWarning,
  invalidateDownloads,
}: GuestSession) => {
  const guestViewVersion = useRef(0);
  const [guestClearStatus, setGuestClearStatus] = useState('');
  const [pendingGuestDeletes, setPendingGuestDeletes] = useState<Reading[]>([]);
  const showGuestData = useCallback(
    (next: AppData) => {
      dataRef.current = next;
      setData(next);
      drawLocked.current = Boolean(next.activeId) || next.awaitingNewReading;
    },
    [dataRef, setData, drawLocked],
  );
  const visibleReadings = (readings: Reading[]) =>
    pendingGuestDeletes.length
      ? readings.filter(
          (item) =>
            !pendingGuestDeletes.some(
              (target) => target.id === item.id && sameReadingContent(item, target),
            ),
        )
      : readings;

  useEffect(() => {
    if (!isGuest) return;
    let active = true;
    const refreshGuest = async () => {
      // A pending local draw/reveal may still be waiting for the guest write lock.
      // Reconcile the saved result after this tab has finished all queued edits.
      let writes;
      do {
        writes = waitForGuestWrites();
        await writes;
      } while (active && writes !== waitForGuestWrites());
      if (!active) return;
      const stored = loadData();
      if (stored.warning) {
        setWarning(stored.warning);
        return;
      }
      if (guestDraft.current) {
        if (guestDraftConflicts(guestDraft.current, stored)) {
          setWarning(guestConflictMessage);
          invalidateDownloads();
        }
        return;
      }
      const view = dataRef.current;
      if (JSON.stringify(view.readings) === JSON.stringify(stored.data.readings)) return;
      const selected = view.readings.find(({ id }) => id === view.activeId);
      const keepSelected =
        selected &&
        stored.data.readings.some(
          (item) => item.id === selected.id && sameReadingContent(item, selected),
        );
      showGuestData({
        ...view,
        readings: stored.data.readings,
        activeId: keepSelected ? view.activeId : null,
      });
      setGuestClearStatus('');
      invalidateDownloads();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === guestStorageKey || event.key === null) void refreshGuest();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('pageshow', refreshGuest);
    return () => {
      active = false;
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('pageshow', refreshGuest);
    };
  }, [isGuest, dataRef, guestDraft, setWarning, showGuestData, invalidateDownloads]);

  const showGuestChange = (next: AppData, view: AppData, version: number) => {
    // Another tab's selection is saved with the shared journal. Keep this
    // tab's selection if its reading survived and the user has not moved on.
    if (version !== guestViewVersion.current) return;
    const activeId = next.readings.some((item) => item.id === view.activeId) ? view.activeId : null;
    showGuestData({ ...view, readings: next.readings, activeId });
  };
  const saveGuestChange = (
    stored: ReturnType<typeof loadData>,
    change: (current: AppData) => AppData,
    view: AppData,
    version: number,
    storageIssue?: string,
  ) => {
    const draft = guestDraft.current;
    const current = draft?.data ?? stored.data;
    const next = change(current);
    const issue = guestDraftConflicts(draft, stored)
      ? guestConflictMessage
      : storageIssue || (stored.storageUnavailable ? guestSaveWarning : saveData(next));
    guestDraft.current = issue ? { data: next, base: draft?.base ?? current } : null;
    setWarning(issue);
    setGuestClearStatus('');
    showGuestChange(next, view, version);
  };
  const commit = (change: (current: AppData) => AppData) => {
    const previous = dataRef.current;
    const view = change(previous);
    const version = ++guestViewVersion.current;
    dataRef.current = view;
    // Settings and navigation take effect before the next tap, even when a
    // sibling is writing. Show new or changed spreads once their save finishes.
    if (view.readings === previous.readings) setData(view);
    // If storage is inaccessible, apply the edit to the view from before this
    // action. The optimistic view already contains the draw or reveal.
    const save = (issue?: string) =>
      saveGuestChange(loadData(previous), change, view, version, issue);
    void withGuestWrite(
      () => save(),
      () => save(guestWriteUnavailable),
    );
  };
  const updateGuestReadings = (readings: Reading[], saved: boolean) => {
    if (saved) {
      guestDraft.current = null;
      setWarning('');
    }
    setGuestClearStatus('');
    const view = dataRef.current;
    showGuestChange({ ...view, readings }, view, guestViewVersion.current);
  };
  const remove = async (reviewed: Reading | Reading[]) => {
    const isClear = Array.isArray(reviewed);
    const targets = isClear ? reviewed : [reviewed];
    const confirmed = new Map(targets.map((item) => [item.id, item]));
    const matches = (item: Reading) => {
      const target = confirmed.get(item.id);
      return target !== undefined && sameReadingContent(item, target);
    };
    const removeConfirmed = (current: AppData) => {
      const remaining = current.readings.filter((item) => !matches(item));
      const activeId = remaining.some((item) => item.id === current.activeId)
        ? current.activeId
        : null;
      return { ...current, readings: remaining, activeId };
    };
    const view = dataRef.current;
    const version = ++guestViewVersion.current;
    if (!isClear) setPendingGuestDeletes((pending) => [...pending, reviewed]);
    invalidateDownloads();
    setGuestClearStatus('');
    await withGuestWrite(
      () => {
        const stored = loadData(view);
        const latest = guestDraft.current ? { data: guestDraft.current.data, warning: '' } : stored;
        if (isClear ? stored.storageUnavailable : latest.warning) {
          setWarning(
            'The saved journal could not be read. Restore storage access and confirm the deletion again.',
          );
          return;
        }
        if (!isClear && !latest.data.readings.some(matches)) {
          if (version === guestViewVersion.current) showGuestData(latest.data);
          setWarning(guestReadingChanged);
          return;
        }
        if (!isClear) {
          saveGuestChange(stored, removeConfirmed, removeConfirmed(view), version);
          if (version !== guestViewVersion.current) {
            // A later action owns the view. Apply just this completed deletion to it.
            dataRef.current = removeConfirmed(dataRef.current);
            setData(removeConfirmed);
          }
          return;
        }
        let remaining = removeConfirmed(latest.data);
        if (guestDraftConflicts(guestDraft.current, stored)) {
          if (remaining.readings.length) {
            setWarning(guestConflictMessage);
            return;
          }
          // Every reading in this tab's draft was selected. Apply that selection
          // to the latest saved journal so a sibling's other readings survive.
          remaining = removeConfirmed(stored.data);
        }
        const outcome = clearGuestHistory(remaining);
        if (outcome === 'journal-write-failed') {
          setWarning(
            'The guest journal could not be cleared. Restore browser storage access and try Clear History again.',
          );
          return;
        }
        guestDraft.current = null;
        showGuestChange(remaining, view, version);
        if (outcome === 'recovery-incomplete') {
          setWarning(
            'The selected guest readings were cleared. Some guest recovery copies may still be on this device. Restore browser storage access and try Clear History again.',
          );
          return;
        }
        setWarning('');
        setGuestClearStatus(
          remaining.readings.length
            ? 'Guest recovery copies were cleared. Readings added or replaced in another tab were kept.'
            : 'Guest history and its recovery copies were cleared from this device.',
        );
      },
      () =>
        setWarning(
          'This browser could not coordinate the deletion with other tabs. Restore browser storage access and confirm again.',
        ),
    ).finally(() => {
      if (!isClear)
        setPendingGuestDeletes((pending) => pending.filter((target) => target !== reviewed));
      invalidateDownloads();
    });
  };
  return { commit, remove, visibleReadings, updateGuestReadings, guestClearStatus };
};
