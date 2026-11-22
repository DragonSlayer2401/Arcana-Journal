'use client';

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
  type ReactNode,
} from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { DECK, CARD_BY_ID } from './data/deck';
import { drawCards } from './domain/random';
import { waitForGuestWrites, withGuestWrite } from './domain/guestWrite';
import { recoverGuestReadings } from './domain/guestRecovery';
import {
  createJournalBackup,
  mergeJournalReadings,
  parseJournalBackup,
  sameReadingContent,
} from './domain/journalBackup';
import {
  clearGuestHistory,
  formatReading,
  freshData,
  guestSaveWarning,
  loadData,
  readSettings,
  saveData,
  STORAGE_KEY,
  type AppData,
} from './domain/storage';
import {
  observeAccount,
  isJournalLocked,
  isJournalLockedInThisTabOnly,
  observeJournalLock,
  exportAccountJournal,
  reviewAccountClear,
  checkReadingsForPendingDeletions,
  previewAccountImport,
  importAccountReadings,
  type JournalUser,
  type AccountClearReview,
  type WatchExportHistory,
} from './cloud/journal';
import { useAccountJournal } from './useAccountJournal';
import { checkSiblingRecovery } from './cloud/journalActivity';
import { IncompleteSignOut, LockedJournal } from './components/LockedJournal';
import type { JournalExport } from './components/JournalTransfer';
import type { Reading, Settings } from './domain/types';
import type { RecoveryCopy } from './domain/readingRecovery';
import { subscribeOfflineStatus } from './pwa';

const CARD_IDS = Object.freeze(DECK.map((card) => card.id));

type GuestChange = (current: AppData) => AppData;
interface GuestDraft {
  data: AppData;
  base: AppData;
}
const guestConflictMessage =
  'The saved guest journal changed while this tab had unsaved readings. Export your backup, then reload and import it to merge the readings.';
const guestWriteUnavailable =
  'This browser could not coordinate changes to the guest journal. Your edits are available in this tab. Export a backup before closing it.';
const guestDraftConflicts = (draft: GuestDraft | null, stored: ReturnType<typeof loadData>) =>
  draft && !stored.warning && JSON.stringify(draft.base) !== JSON.stringify(stored.data);

export default function JournalProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<JournalUser | null | undefined>(undefined);
  const guestDraft = useRef<GuestDraft | null>(null);
  useEffect(() => observeAccount(setUser), []);
  if (user?.signOutIncomplete) return <IncompleteSignOut uid={user.uid} />;
  const journalUid = user?.emailVerified ? user.uid : undefined;
  return (
    <JournalSession
      key={user === undefined ? 'opening' : journalUid ? `account:${journalUid}` : 'guest'}
      user={user}
      journalUid={journalUid}
      guestDraft={guestDraft}
    >
      {children}
    </JournalSession>
  );
}

const sessionKey = (uid: string) => `arcana.reading-view.${uid}`;
const loadAccountView = (uid: string) => {
  const data = freshData();
  try {
    const view = JSON.parse(sessionStorage.getItem(sessionKey(uid)) ?? 'null');
    if (view) {
      if (typeof view.activeId === 'string') data.activeId = view.activeId;
      data.awaitingNewReading = view.awaitingNewReading === true || Boolean(data.activeId);
      data.settings = readSettings(view.settings) ?? data.settings;
    }
  } catch {
    /* Tab storage is optional. */
  }
  return { data, warning: '' };
};

interface SessionProps {
  user: JournalUser | null | undefined;
  journalUid: string | undefined;
  guestDraft: RefObject<GuestDraft | null>;
}

function useJournalController({ user, journalUid, guestDraft }: SessionProps) {
  const opening = user === undefined;
  const uid = user?.uid;
  const subscribeToLock = useCallback(
    (notify: () => void) => (uid ? observeJournalLock(uid, notify) : () => {}),
    [uid],
  );
  const lockScope = useSyncExternalStore(
    subscribeToLock,
    () => {
      if (!uid || !isJournalLocked(uid)) return 'open';
      return isJournalLockedInThisTabOnly(uid) ? 'tab' : 'browser';
    },
    () => 'open',
  );
  const locked = lockScope !== 'open';
  // The server and the first client render use the same public view. Only the
  // resolved browser session may read device storage or subscribe to private data.
  const [initial] = useState(() =>
    opening
      ? { data: freshData(), warning: '' }
      : journalUid
        ? loadAccountView(journalUid)
        : guestDraft.current
          ? {
              data: guestDraft.current.data,
              warning: 'Your unsaved guest readings are available in this session.',
            }
          : loadData(),
  );
  const [data, setData] = useState(initial.data);
  const dataRef = useRef(data);
  const guestViewVersion = useRef(0);
  const drawLocked = useRef(Boolean(data.activeId) || data.awaitingNewReading);
  // Detach the reading listeners while locked. Keep this session's write and retry state
  // alive until the account changes, including draws that are still waiting on Firebase.
  const account = useAccountJournal(journalUid, data.activeId, locked);
  const getDeviceCount = useCallback(
    () => (guestDraft.current ? ('unsaved' as const) : loadData().data.readings.length),
    [guestDraft],
  );
  const [deviceCount, setDeviceCount] = useState(() => (journalUid ? getDeviceCount() : 0));
  useEffect(() => {
    if (!journalUid) return;
    let active = true;
    const refreshCount = () => {
      if (active) setDeviceCount(getDeviceCount());
    };
    // A guest write can finish after signing in has mounted the account journal.
    void waitForGuestWrites().then(refreshCount);
    window.addEventListener('storage', refreshCount);
    return () => {
      active = false;
      window.removeEventListener('storage', refreshCount);
    };
  }, [journalUid, getDeviceCount]);
  const [warning, setWarning] = useState(initial.warning);
  const [guestClearStatus, setGuestClearStatus] = useState('');
  const [error, setError] = useState('');
  const [question, setQuestion] = useState('');
  const router = useRouter();
  const pathname = usePathname();
  const [authEmail, setAuthEmail] = useState('');
  useEffect(() => {
    if (pathname !== '/login' && pathname !== '/signup' && pathname !== '/reset-password')
      setAuthEmail('');
  }, [pathname]);
  const [help, setHelp] = useState(false);
  const [details, setDetails] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Reading | 'all' | null>(null);
  const [pendingGuestDeletes, setPendingGuestDeletes] = useState<Reading[]>([]);
  const guestClearTargets = useRef<Reading[]>([]);
  const [historyRevision, setHistoryRevision] = useState(0);
  const invalidateDownloads = () => setHistoryRevision((value) => value + 1);
  const [clearReview, setClearReview] = useState<AccountClearReview | null>(null);
  const [clearReviewError, setClearReviewError] = useState('');
  const [copyText, setCopyText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [offline, setOffline] = useState<'checking' | 'ready' | 'unavailable' | 'error'>(
    'checking',
  );
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const readings = journalUid
    ? account.entries
    : pendingGuestDeletes.length
      ? data.readings.filter(
          (item) =>
            !pendingGuestDeletes.some(
              (target) => target.id === item.id && sameReadingContent(item, target),
            ),
        )
      : data.readings;
  const reading = journalUid ? account.active : readings.find((item) => item.id === data.activeId);
  const count =
    data.settings.mode === 'one'
      ? 1
      : data.settings.mode === 'three'
        ? 3
        : data.settings.customCount;
  const revealedCount = reading?.revealed.filter(Boolean).length ?? 0;

  useEffect(() => {
    if (opening || journalUid) return;
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
          setHistoryRevision((value) => value + 1);
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
      const next = {
        ...view,
        readings: stored.data.readings,
        activeId: keepSelected ? view.activeId : null,
      };
      dataRef.current = next;
      setData(next);
      drawLocked.current = Boolean(next.activeId) || next.awaitingNewReading;
      setGuestClearStatus('');
      setHistoryRevision((value) => value + 1);
      if (selected && !keepSelected) {
        setDetails(null);
        setCopyText(null);
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) void refreshGuest();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('pageshow', refreshGuest);
    return () => {
      active = false;
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('pageshow', refreshGuest);
    };
  }, [opening, journalUid, guestDraft]);

  useEffect(() => {
    setDetails(null);
    setConfirmDelete(null);
    setCopyText(null);
    setHelp(false);
  }, [pathname, locked]);

  useEffect(() => {
    setClearReview(null);
    setClearReviewError('');
    if (confirmDelete !== 'all') guestClearTargets.current = [];
    if (confirmDelete !== 'all' || !journalUid || locked) return;
    let active = true;
    void reviewAccountClear(journalUid).then(
      (review) => {
        if (active) setClearReview(review);
      },
      (error: unknown) => {
        if (active)
          setClearReviewError(
            error instanceof Error ? error.message : 'Could not load your journal.',
          );
      },
    );
    return () => {
      active = false;
    };
  }, [confirmDelete, journalUid, locked]);

  useEffect(() => {
    if (!confirmDelete || confirmDelete === 'all') return;
    const current = readings.find(({ id }) => id === confirmDelete.id);
    if (!current || !sameReadingContent(current, confirmDelete)) {
      setConfirmDelete(null);
      if (!journalUid)
        setWarning('This reading changed in another tab. Review the journal and confirm again.');
    }
  }, [confirmDelete, readings, journalUid]);

  useEffect(
    () =>
      !opening
        ? subscribeOfflineStatus((status, update) => {
            setOffline(status);
            setUpdateAvailable(update);
          })
        : undefined,
    [opening],
  );

  const showData = (next: AppData) => {
    dataRef.current = next;
    setData(next);
  };
  const currentJournal = () => {
    const draft = guestDraft.current;
    return draft ? { data: draft.data, warning: '' } : loadData();
  };
  const showGuestChange = (next: AppData, view: AppData, version: number) => {
    // Another tab's selection is saved with the shared journal. Keep this
    // tab's selection if its reading survived and the user has not moved on.
    if (version !== guestViewVersion.current) return;
    const activeId = next.readings.some((item) => item.id === view.activeId) ? view.activeId : null;
    showData({ ...view, readings: next.readings, activeId });
    drawLocked.current = Boolean(activeId) || view.awaitingNewReading;
  };
  const saveGuestChange = (
    stored: ReturnType<typeof loadData>,
    change: GuestChange,
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
    return issue;
  };
  const commit = (change: GuestChange) => {
    if (journalUid) {
      const next = change(dataRef.current);
      const { settings, activeId, awaitingNewReading } = next;
      try {
        sessionStorage.setItem(
          sessionKey(journalUid),
          JSON.stringify({ settings, activeId, awaitingNewReading }),
        );
      } catch {
        /* Reading data is saved separately in Firestore. */
      }
      showData(next);
      return;
    }
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
  const guestReadingsForTransfer = async () => {
    await waitForGuestWrites();
    const draft = guestDraft.current;
    const stored = loadData();
    if (draft)
      return guestDraftConflicts(draft, stored)
        ? recoverGuestReadings(draft.base.readings, draft.data.readings, stored.data.readings)
        : draft.data.readings;
    if (stored.warning) throw new Error('The saved journal could not be read to create a backup.');
    return stored.data.readings;
  };
  const exportJournal = async (allowUncheckedDeletions = false): Promise<JournalExport> => {
    if (journalUid) {
      const checkOtherTabs = async () => {
        const status = await checkSiblingRecovery(journalUid);
        if (status === 'busy')
          throw new Error(
            'Another tab has unsynced journal changes. Sync or recover those readings in that tab, then export again.',
          );
      };
      await checkOtherTabs();
      let watchHistory: WatchExportHistory | undefined;
      let json = await exportAccountJournal(journalUid, allowUncheckedDeletions, (watch) => {
        watchHistory = watch;
      });
      const cloudReadings = parseJournalBackup(json);
      const recovery = account.getRecoveryForExport();
      if (!recovery.complete)
        throw new Error(
          'A complete backup needs access to every recovery copy. Allow browser storage and export again.',
        );
      if (recovery.readings.length) {
        const { readings } = await mergeJournalReadings(
          cloudReadings,
          recovery.readings,
          recovery.assignedIds,
        );
        await checkReadingsForPendingDeletions(
          journalUid,
          readings.map(({ id }) => id),
          allowUncheckedDeletions,
        );
        json = await createJournalBackup(() => ({ readings, nextCursor: null }));
      }
      await checkOtherTabs();
      // An isolated or suspended tab may be unable to advertise memory-only readings.
      return {
        json,
        scope: allowUncheckedDeletions ? 'unchecked-deletions' : 'cloud-and-tab',
        watchHistory,
      };
    }
    const json = await createJournalBackup(async () => ({
      readings: await guestReadingsForTransfer(),
      nextCursor: null,
    }));
    return { json, scope: 'journal' };
  };
  const deviceJournal = () => {
    if (guestDraft.current && guestDraftConflicts(guestDraft.current, loadData()))
      throw new Error(guestConflictMessage);
    const { data: device, warning: readWarning } = currentJournal();
    if (readWarning) {
      throw new Error(
        'The saved journal could not be read to merge this backup. You can restore the file in another browser.',
      );
    }
    return device;
  };
  const previewImport = (
    incoming: Reading[],
    onProgress?: (done: number, total: number) => void,
  ) =>
    journalUid
      ? previewAccountImport(journalUid, incoming, onProgress)
      : mergeJournalReadings(deviceJournal().readings, incoming);
  const importJournal = async (
    incoming: Reading[],
    onProgress?: (done: number, total: number) => void,
    allowUncheckedDeletions = false,
    retainedCopies?: RecoveryCopy[],
    recovering = false,
  ) => {
    if (journalUid)
      return importAccountReadings(
        journalUid,
        incoming,
        onProgress,
        allowUncheckedDeletions,
        retainedCopies,
        recovering,
      );
    // Hash older IDs outside the storage transaction. Retry the merge if a
    // sibling changed the guest journal before the final synchronous save.
    for (;;) {
      const current = deviceJournal();
      const result = await mergeJournalReadings(current.readings, incoming);
      const saved = await withGuestWrite(() => {
        if (JSON.stringify(deviceJournal()) !== JSON.stringify(current)) return false;
        const next = { ...current, readings: result.readings };
        if (result.added || result.updated || guestDraft.current) {
          if (saveData(next))
            throw new Error(
              'This device could not save the imported readings. Keep your backup and try again.',
            );
          guestDraft.current = null;
          setWarning('');
        }
        setGuestClearStatus('');
        const view = dataRef.current;
        const activeId = next.readings.some((item) => item.id === view.activeId)
          ? view.activeId
          : null;
        showData({ ...view, readings: next.readings, activeId });
        drawLocked.current = Boolean(activeId) || view.awaitingNewReading;
        return true;
      });
      if (saved) return result;
    }
  };
  const updateSettings = (patch: Partial<Settings>) => {
    commit((current) => ({ ...current, settings: { ...current.settings, ...patch } }));
  };
  const draw = (event: React.FormEvent) => {
    event.preventDefault();
    if (
      opening ||
      drawLocked.current ||
      dataRef.current.activeId ||
      dataRef.current.awaitingNewReading
    )
      return;
    drawLocked.current = true; // Synchronous guard also blocks taps before React commits.
    setError('');
    try {
      const settings = dataRef.current.settings;
      const requested =
        settings.mode === 'one' ? 1 : settings.mode === 'three' ? 3 : settings.customCount;
      const cards = drawCards(CARD_IDS, requested, settings.reversals);
      const result: Reading = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        question: question.trim(),
        cards,
        revealed: cards.map(() => settings.instantReveal),
      };
      if (journalUid) account.saveDraw(result);
      commit((current) => ({
        ...current,
        readings: journalUid
          ? []
          : [result, ...current.readings.filter((item) => item.id !== result.id)],
        activeId: result.id,
        awaitingNewReading: true,
      }));
      setCopied(false);
    } catch (cause) {
      drawLocked.current = false;
      setError(
        cause instanceof Error
          ? cause.message
          : 'Secure randomness is unavailable. No cards were drawn.',
      );
    }
  };
  const reveal = (index?: number) => {
    if (journalUid && reading) {
      account.reveal(reading.id, index === undefined ? reading.cards.map((_, i) => i) : [index]);
      return;
    }
    if (!reading) return;
    commit((current) => ({
      ...current,
      readings: current.readings.map((item) =>
        item.id === reading.id && sameReadingContent(item, reading)
          ? {
              ...item,
              revealed: item.revealed.map(
                (value, i) => index === undefined || i === index || value,
              ),
            }
          : item,
      ),
    }));
  };
  const newReading = () => {
    commit((current) => ({ ...current, activeId: null, awaitingNewReading: false }));
    drawLocked.current = false;
    setQuestion('');
    setDetails(null);
    setCopied(false);
    setError('');
  };
  const handleReadingLinkClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
      return;
    const { activeId, awaitingNewReading } = dataRef.current;
    if (activeId || awaitingNewReading) newReading();
  };
  const openReading = (id: string) => {
    commit((current) => ({
      ...current,
      activeId: journalUid || current.readings.some((item) => item.id === id) ? id : null,
      awaitingNewReading: true,
    }));
    drawLocked.current = true;
    setDetails(null);
    setCopied(false);
    setError('');
    router.push('/');
  };
  const deleteReadings = async () => {
    if (!confirmDelete || (uid && isJournalLocked(uid))) {
      setConfirmDelete(null);
      return;
    }
    if (journalUid) {
      const target = confirmDelete === 'all' ? undefined : confirmDelete;
      if (!target && !clearReview) return;
      const previousActive = dataRef.current.activeId;
      setConfirmDelete(null);
      invalidateDownloads();
      try {
        await account.remove(target?.id, target, clearReview ?? undefined);
        if ((target?.id ?? previousActive) === dataRef.current.activeId) {
          commit((current) => ({ ...current, activeId: null }));
        }
      } catch {
        /* The journal displays the cloud error and permits another attempt. */
      } finally {
        // A multi-page clear can stop after committing some of its deletions.
        invalidateDownloads();
      }
      return;
    }
    const targets = confirmDelete === 'all' ? guestClearTargets.current : [confirmDelete];
    const confirmed = new Map(targets.map((item) => [item.id, item]));
    const view = dataRef.current;
    const version = ++guestViewVersion.current;
    if (confirmDelete !== 'all') setPendingGuestDeletes((pending) => [...pending, confirmDelete]);
    setConfirmDelete(null);
    invalidateDownloads();
    setGuestClearStatus('');
    await withGuestWrite(
      () => {
        const stored = loadData(view);
        const latest = guestDraft.current ? { data: guestDraft.current.data, warning: '' } : stored;
        if (confirmDelete === 'all' ? stored.storageUnavailable : latest.warning) {
          setWarning(
            'The saved journal could not be read. Restore storage access and confirm the deletion again.',
          );
          return;
        }
        const matches = (item: Reading) => {
          const target = confirmed.get(item.id);
          return target !== undefined && sameReadingContent(item, target);
        };
        if (confirmDelete !== 'all' && !latest.data.readings.some(matches)) {
          if (version === guestViewVersion.current) {
            showData(latest.data);
            drawLocked.current = Boolean(latest.data.activeId) || latest.data.awaitingNewReading;
          }
          setWarning('This reading changed in another tab. Review the journal and confirm again.');
          return;
        }
        const removeConfirmed = (current: AppData) => {
          const remaining = current.readings.filter((item) => !matches(item));
          const activeId = remaining.some((item) => item.id === current.activeId)
            ? current.activeId
            : null;
          return { ...current, readings: remaining, activeId };
        };
        if (confirmDelete !== 'all') {
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
      if (confirmDelete !== 'all')
        setPendingGuestDeletes((pending) => pending.filter((target) => target !== confirmDelete));
    });
    invalidateDownloads();
  };
  const copyReading = async () => {
    if (!reading) return;
    const text = formatReading(reading);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopyText(text);
    }
  };
  const selected = reading && details !== null ? reading.cards[details] : null;
  const selectedCard = selected ? CARD_BY_ID.get(selected.cardId)! : null;

  const requestClear = () => {
    if (!journalUid) guestClearTargets.current = dataRef.current.readings;
    setConfirmDelete('all');
  };
  return {
    user,
    journalUid,
    opening,
    account,
    readings,
    reading,
    data,
    count,
    question,
    setQuestion,
    updateSettings,
    draw,
    newReading,
    revealedCount,
    reveal,
    setDetails,
    copyReading,
    copied,
    error,
    guestClearStatus,
    openReading,
    setConfirmDelete,
    requestClear,
    historyRevision,
    deviceCount,
    guestReadingsForTransfer,
    exportJournal,
    previewImport,
    importJournal,
    authEmail,
    setAuthEmail,
    lockScope,
    locked,
    handleReadingLinkClick,
    setHelp,
    warning,
    offline,
    updateAvailable,
    help,
    selected,
    selectedCard,
    details,
    confirmDelete,
    clearReview,
    clearReviewError,
    deleteReadings,
    copyText,
    setCopyText,
  };
}

const JournalContext = createContext<ReturnType<typeof useJournalController> | null>(null);
export const useJournalSession = () => {
  const session = useContext(JournalContext);
  if (!session) throw new Error('Missing journal session.');
  return session;
};

function JournalSession({ children, ...props }: SessionProps & { children: ReactNode }) {
  const session = useJournalController(props);
  const { user, locked, account, lockScope } = session;
  if (user && locked) {
    return (
      <LockedJournal
        key={user.uid}
        uid={user.uid}
        hasFailedWrites={account.hasFailedWrites}
        saving={account.saving}
        needsOpenTab={account.needsOpenTab}
        tabOnly={lockScope === 'tab'}
      />
    );
  }

  return <JournalContext.Provider value={session}>{children}</JournalContext.Provider>;
}
