'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  guestReadingChanged,
  useGuestJournal,
} from '../features/GuestJournal/hooks/useGuestJournal';
import type { GuestDraft } from '../features/GuestJournal/utils/guestDraft';
import { sameReadingContent } from '../utils/readingIdentity';
import {
  defaultReadingPreferences,
  freshData,
  readSettings,
  type AppData,
} from '../utils/journalData';
import { loadData } from '../features/GuestJournal/utils/guestStorage';
import {
  isJournalLocked,
  isJournalLockedInThisTabOnly,
  observeJournalLock,
  type JournalUser,
} from '@/services/Account/account.service';
import { reviewAccountClear, type AccountClearReview } from '@/services/Journal/journal.service';
import { useAccountJournal } from '../features/AccountJournal/hooks/useAccountJournal';
import { useReadingPreferences } from '@/features/Account/hooks/useReadingPreferences';
import type { Reading, ReadingPreferences, Settings } from '../readingTypes';
import { subscribeOfflineStatus } from '@/utils/pwa';

const sessionKey = (uid: string) => `arcana.reading-view.${uid}`;
const loadAccountView = (uid: string) => {
  const data = freshData();
  try {
    const view = JSON.parse(sessionStorage.getItem(sessionKey(uid)) ?? 'null');
    if (view) {
      if (typeof view.activeId === 'string') data.activeId = view.activeId;
      data.awaitingNewReading = view.awaitingNewReading === true || Boolean(data.activeId);
      data.settings =
        readSettings({ ...view.settings, ...defaultReadingPreferences }) ?? data.settings;
    }
  } catch {
    /* Tab storage is optional. */
  }
  return { data, warning: '' };
};

export interface JournalSessionProps {
  user: JournalUser | null | undefined;
  journalUid: string | undefined;
  guestDraft: RefObject<GuestDraft | null>;
}

export const useJournalController = ({ user, journalUid, guestDraft }: JournalSessionProps) => {
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
  const profile = useReadingPreferences(locked ? undefined : uid);
  const drawDisabled = opening || locked || Boolean(uid && !profile.ready);
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
  const drawLocked = useRef(Boolean(data.activeId) || data.awaitingNewReading);
  // Detach the reading listeners while locked. Keep this session's write and retry state
  // alive until the account changes, including draws that are still waiting on Firebase.
  const account = useAccountJournal(journalUid, data.activeId, locked);
  const getGuestDraft = useCallback(() => guestDraft.current, [guestDraft]);
  const [warning, setWarning] = useState(initial.warning);
  const [error, setError] = useState('');
  const [question, setQuestion] = useState('');
  const router = useRouter();
  const pathname = usePathname();
  const [help, setHelp] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Reading | 'all' | null>(null);
  const guestClearTargets = useRef<Reading[]>([]);
  const [historyRevision, setHistoryRevision] = useState(0);
  const invalidateDownloads = useCallback(() => setHistoryRevision((value) => value + 1), []);
  const guest = useGuestJournal({
    isGuest: !opening && !journalUid,
    dataRef,
    setData,
    drawLocked,
    guestDraft,
    setWarning,
    invalidateDownloads,
  });
  const [clearReview, setClearReview] = useState<AccountClearReview | null>(null);
  const [clearReviewError, setClearReviewError] = useState('');
  const [offline, setOffline] = useState<'checking' | 'ready' | 'unavailable' | 'error'>(
    'checking',
  );
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const readings = journalUid ? account.entries : guest.visibleReadings(data.readings);
  const reading = journalUid ? account.active : readings.find((item) => item.id === data.activeId);

  useEffect(() => {
    setConfirmDelete(null);
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
      if (!journalUid) setWarning(guestReadingChanged);
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

  const commit = (change: (current: AppData) => AppData) => {
    if (!journalUid) {
      guest.commit(change);
      return;
    }
    const next = change(dataRef.current);
    const {
      activeId,
      awaitingNewReading,
      settings: { mode, customCount },
    } = next;
    try {
      sessionStorage.setItem(
        sessionKey(journalUid),
        JSON.stringify({ settings: { mode, customCount }, activeId, awaitingNewReading }),
      );
    } catch {
      /* Reading data is saved separately in Firestore. */
    }
    dataRef.current = next;
    setData(next);
  };
  const updateSpread = (patch: Partial<Pick<Settings, 'mode' | 'customCount'>>) => {
    commit((current) => ({ ...current, settings: { ...current.settings, ...patch } }));
  };
  const updatePreference = (key: keyof ReadingPreferences, value: boolean) => {
    if (drawDisabled) return;
    if (uid) {
      void profile.update(key, value);
      return;
    }
    guest.updatePreference(key, value);
  };
  const draw = (createReading: (settings: Settings, question: string) => Reading) => {
    if (
      drawDisabled ||
      drawLocked.current ||
      dataRef.current.activeId ||
      dataRef.current.awaitingNewReading
    )
      return;
    drawLocked.current = true; // Synchronous guard also blocks taps before React commits.
    setError('');
    try {
      const settings = dataRef.current.settings;
      const preferences = uid ? profile.getPreferences() : guest.getPreferences();
      const result = createReading({ ...settings, ...preferences }, question);
      if (journalUid) account.saveDraw(result);
      commit((current) => ({
        ...current,
        readings: journalUid
          ? []
          : [result, ...current.readings.filter((item) => item.id !== result.id)],
        activeId: result.id,
        awaitingNewReading: true,
      }));
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
    const reviewed = confirmDelete === 'all' ? guestClearTargets.current : confirmDelete;
    setConfirmDelete(null);
    await guest.remove(reviewed);
  };
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
    question,
    setQuestion,
    updateSpread,
    preferences: uid ? profile.preferences : guest.preferences,
    preferenceWarning: uid ? profile.warning : guest.preferenceWarning,
    retryPreferenceSync: uid ? profile.retry : undefined,
    updatePreference,
    drawDisabled,
    draw,
    newReading,
    reveal,
    error,
    guestClearStatus: guest.guestClearStatus,
    openReading,
    setConfirmDelete,
    requestClear,
    historyRevision,
    getGuestDraft,
    updateGuestReadings: guest.updateGuestReadings,
    lockScope,
    locked,
    handleReadingLinkClick,
    setHelp,
    warning,
    offline,
    updateAvailable,
    help,
    confirmDelete,
    clearReview,
    clearReviewError,
    deleteReadings,
  };
};
