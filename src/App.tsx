import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import {
  Link,
  Navigate,
  NavLink,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
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
  formatReading,
  freshData,
  guestSaveWarning,
  loadData,
  saveData,
  type AppData,
} from './domain/storage';
import {
  observeAccount,
  isJournalLocked,
  isJournalLockedInThisTabOnly,
  observeJournalLock,
  lockJournal,
  exportAccountJournal,
  checkReadingsForPendingDeletions,
  previewAccountImport,
  importAccountReadings,
  type JournalUser,
} from './cloud/journal';
import { useAccountJournal } from './useAccountJournal';
import { checkSiblingRecovery } from './cloud/journalActivity';
import { AccountForm } from './components/AccountForm';
import { AccountPanel } from './components/AccountPanel';
import { IncompleteSignOut, LockedJournal } from './components/LockedJournal';
import { JournalTransfer, type JournalExport } from './components/JournalTransfer';
import type { Reading, Settings } from './domain/types';
import type { RecoveryCopy } from './domain/readingRecovery';
import { CardArtwork, CardBackArtwork } from './components/CardArtwork';
import { CardLibrary } from './components/CardLibrary';
import { JournalPage } from './components/JournalPage';
import { Icon } from './components/Icons';
import { Modal } from './components/Modal';
import { subscribeOfflineStatus } from './pwa';

const CARD_IDS = Object.freeze(DECK.map((card) => card.id));
const dateLabel = (date: string) =>
  new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

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

export default function App() {
  const [user, setUser] = useState<JournalUser | null | undefined>(undefined);
  const guestDraft = useRef<GuestDraft | null>(null);
  useEffect(() => observeAccount(setUser), []);
  if (user === undefined)
    return (
      <main>
        <p role="status">Opening Arcana Journal…</p>
      </main>
    );
  if (user?.signOutIncomplete) return <IncompleteSignOut uid={user.uid} />;
  const journalUid = user?.emailVerified ? user.uid : undefined;
  return (
    <JournalSession
      key={journalUid ? `account:${journalUid}` : 'guest'}
      user={user}
      journalUid={journalUid}
      guestDraft={guestDraft}
    />
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
      if (
        ['one', 'three', 'custom'].includes(view.settings?.mode) &&
        Number.isInteger(view.settings.customCount) &&
        view.settings.customCount >= 1 &&
        view.settings.customCount <= 10 &&
        typeof view.settings.reversals === 'boolean'
      ) {
        data.settings = view.settings;
      }
    }
  } catch {
    /* Tab storage is optional. */
  }
  return { data, warning: '' };
};

function JournalSession({
  user,
  journalUid,
  guestDraft,
}: {
  user: JournalUser | null;
  journalUid: string | undefined;
  guestDraft: RefObject<GuestDraft | null>;
}) {
  const uid = user?.uid;
  const subscribeToLock = useCallback(
    (notify: () => void) => (uid ? observeJournalLock(uid, notify) : () => {}),
    [uid],
  );
  const lockScope = useSyncExternalStore(subscribeToLock, () => {
    if (!uid || !isJournalLocked(uid)) return 'open';
    return isJournalLockedInThisTabOnly(uid) ? 'tab' : 'browser';
  });
  const locked = lockScope !== 'open';
  const [initial] = useState(() =>
    journalUid
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
  const [error, setError] = useState('');
  const [question, setQuestion] = useState('');
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [help, setHelp] = useState(false);
  const [details, setDetails] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Reading | 'all' | null>(null);
  const [copyText, setCopyText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [offline, setOffline] = useState<'checking' | 'ready' | 'unavailable' | 'error'>(
    'checking',
  );
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const readings = journalUid ? account.entries : data.readings;
  const reading = journalUid ? account.active : readings.find((item) => item.id === data.activeId);
  const count =
    data.settings.mode === 'one'
      ? 1
      : data.settings.mode === 'three'
        ? 3
        : data.settings.customCount;
  const revealedCount = reading?.revealed.filter(Boolean).length ?? 0;

  useEffect(() => {
    setDetails(null);
    setConfirmDelete(null);
    setCopyText(null);
    setHelp(false);
  }, [pathname, locked]);

  useEffect(() => {
    if (!confirmDelete || confirmDelete === 'all') return;
    const current = readings.find(({ id }) => id === confirmDelete.id);
    if (!current || !sameReadingContent(current, confirmDelete)) setConfirmDelete(null);
  }, [confirmDelete, readings]);

  useEffect(
    () =>
      subscribeOfflineStatus((status, update) => {
        setOffline(status);
        setUpdateAvailable(update);
      }),
    [],
  );

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

  const showData = (next: AppData) => {
    dataRef.current = next;
    setData(next);
  };
  const currentJournal = () => {
    const draft = guestDraft.current;
    return draft ? { data: draft.data, warning: '' } : loadData();
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
    // Another tab's selected spread is part of its saved state. Keep this tab
    // on the spread the user was viewing when they made the edit.
    if (version === guestViewVersion.current) {
      const activeId = next.readings.some((item) => item.id === view.activeId)
        ? view.activeId
        : null;
      showData({ ...view, readings: next.readings, activeId });
      drawLocked.current = Boolean(activeId) || view.awaitingNewReading;
    }
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
      let json = await exportAccountJournal(journalUid, allowUncheckedDeletions);
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
      return { json, scope: allowUncheckedDeletions ? 'unchecked-deletions' : 'cloud-and-tab' };
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
    if (drawLocked.current || dataRef.current.activeId || dataRef.current.awaitingNewReading)
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
        revealed: cards.map(() => false),
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
    navigate('/');
  };
  const deleteReadings = async () => {
    if (!confirmDelete || (uid && isJournalLocked(uid))) {
      setConfirmDelete(null);
      return;
    }
    if (journalUid) {
      const target = confirmDelete === 'all' ? undefined : confirmDelete;
      setConfirmDelete(null);
      try {
        await account.remove(target?.id, target);
        if (!target || dataRef.current.activeId === target.id) {
          commit((current) => ({ ...current, activeId: null }));
        }
      } catch {
        /* The journal displays the cloud error and permits another attempt. */
      }
      return;
    }
    const targets = confirmDelete === 'all' ? dataRef.current.readings : [confirmDelete];
    const confirmed = new Map(targets.map((item) => [item.id, item]));
    const view = dataRef.current;
    const version = ++guestViewVersion.current;
    setConfirmDelete(null);
    await withGuestWrite(
      () => {
        const stored = loadData(view);
        const latest = guestDraft.current ? { data: guestDraft.current.data, warning: '' } : stored;
        if (latest.warning) {
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
        const issue = saveGuestChange(stored, removeConfirmed, removeConfirmed(view), version);
        if (!issue && confirmDelete === 'all' && dataRef.current.readings.length)
          setWarning('Readings added or replaced in another tab were kept.');
      },
      () =>
        setWarning(
          'This browser could not coordinate the deletion with other tabs. Restore browser storage access and confirm again.',
        ),
    );
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

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="header-identity">
          <Link className="wordmark" to="/" aria-label="Arcana Journal, reading">
            <span className="brand-symbol">
              <Icon name="spark" size={27} />
            </span>
            <span>
              Arcana Journal<span className="wordmark-caption">A LITTLE SPACE FOR REFLECTION</span>
            </span>
          </Link>
          {!user && (
            <div className="header-account-links">
              <NavLink to="/login">Sign in</NavLink>
              <NavLink className="header-signup" to="/signup">
                Create account
              </NavLink>
            </div>
          )}
        </div>
        <nav aria-label="Main navigation">
          <NavLink className="nav-button" to="/" end>
            <Icon name="cards" />
            <span>Reading</span>
          </NavLink>
          <NavLink className="nav-button" to="/deck">
            <Icon name="library" />
            <span>Deck</span>
          </NavLink>
          <NavLink className="nav-button" to="/journal">
            <Icon name="book" />
            <span>Journal</span>
            {readings.length > 0 && (
              <span className="nav-count">
                {readings.length}
                {journalUid && account.hasMore ? '+' : ''}
              </span>
            )}
          </NavLink>
          <button
            className="icon-button help-button"
            aria-label="About, installation, and randomness"
            onClick={() => setHelp(true)}
          >
            <Icon name="info" />
          </button>
        </nav>
      </header>

      <main id="main">
        {journalUid && account.deleteError && (
          <p className="notice warning" role="alert">
            {account.deleteError}
          </p>
        )}
        {journalUid && account.syncError && (
          <div className="notice warning" role="alert">
            {account.syncError}{' '}
            <button type="button" className="button button-secondary" onClick={account.retrySync}>
              Retry sync
            </button>
          </div>
        )}
        {warning && (
          <p className="notice warning" role="alert">
            {warning}
          </p>
        )}
        <Routes>
          <Route
            path="/"
            element={
              <>
                {account.loadingActive && (
                  <div className="empty-journal">
                    <p role="status">Looking for your saved reading…</p>
                    <button className="button button-secondary" onClick={newReading}>
                      Start a new reading
                    </button>
                  </div>
                )}
                {!account.loadingActive && !reading && data.awaitingNewReading && (
                  <section className="empty-journal">
                    <Icon name="moon" size={46} />
                    <h1>A little space to begin again.</h1>
                    <p>
                      {journalUid
                        ? 'This reading is unavailable on this device.'
                        : 'Your previous reading has been removed.'}
                    </p>
                    <button className="button button-gold" onClick={newReading}>
                      <Icon name="spark" />
                      New Reading
                    </button>
                  </section>
                )}
                {!reading && !data.awaitingNewReading && (
                  <>
                    <section className="intro">
                      <p className="eyebrow">
                        <span /> YOUR MOMENT OF STILLNESS <span />
                      </p>
                      <h1>
                        A question. A card.
                        <br />
                        <em>A new perspective.</em>
                      </h1>
                      <p>
                        Let the cards be a starting point.
                        <br className="mobile-break" /> The meaning you find is yours.
                      </p>
                    </section>
                    <section className="reading-workspace" aria-label="Prepare your reading">
                      <div className="deck-preview" aria-hidden="true">
                        <div className="orbital orbital-one" />
                        <div className="orbital orbital-two" />
                        <span className="sky-star star-one">✦</span>
                        <span className="sky-star star-two">✧</span>
                        <span className="sky-star star-three">✦</span>
                        <div className="preview-card preview-left">
                          <CardBackArtwork />
                        </div>
                        <div className="preview-card preview-right">
                          <CardBackArtwork />
                        </div>
                        <div className="preview-card preview-center">
                          <CardBackArtwork />
                        </div>
                        <p className="deck-caption">78 CARDS · ENDLESS PERSPECTIVES</p>
                      </div>
                      <form className="reading-form" onSubmit={draw}>
                        <div className="form-heading">
                          <span className="mini-star">✧</span>
                          <h2>Make room for a reading</h2>
                        </div>
                        <fieldset>
                          <legend>Choose your spread</legend>
                          <div className="mode-options">
                            {(
                              [
                                ['one', 'One card', 'A single focus'],
                                ['three', 'Three cards', 'Room to explore'],
                                ['custom', 'Custom', 'Your own spread'],
                              ] as const
                            ).map(([mode, label, description]) => (
                              <button
                                type="button"
                                key={mode}
                                aria-pressed={data.settings.mode === mode}
                                className={
                                  data.settings.mode === mode
                                    ? 'mode-option selected'
                                    : 'mode-option'
                                }
                                onClick={() => updateSettings({ mode })}
                              >
                                <span className="mode-glyph" aria-hidden="true">
                                  {mode === 'one' ? '▯' : mode === 'three' ? '▯▯▯' : '✧'}
                                </span>
                                <strong>{label}</strong>
                                <small>{description}</small>
                              </button>
                            ))}
                          </div>
                        </fieldset>
                        {data.settings.mode === 'custom' && (
                          <label className="custom-count">
                            Number of cards{' '}
                            <select
                              value={data.settings.customCount}
                              onChange={(event) =>
                                updateSettings({ customCount: Number(event.target.value) })
                              }
                            >
                              {Array.from({ length: 10 }, (_, i) => (
                                <option key={i + 1} value={i + 1}>
                                  {i + 1}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                        <label className="question-label" htmlFor="question">
                          What’s on your mind? <span>optional</span>
                        </label>
                        <textarea
                          id="question"
                          value={question}
                          maxLength={2000}
                          onChange={(event) => setQuestion(event.target.value)}
                          placeholder="A question, an intention, or simply an open mind…"
                          rows={3}
                        />
                        <p className="field-hint">
                          A note for your journal. It never influences the draw.
                        </p>
                        <label className="reversal-setting">
                          <span>
                            <strong>Include reversals</strong>
                            <small>Allow upright and reversed cards</small>
                          </span>
                          <input
                            type="checkbox"
                            checked={data.settings.reversals}
                            onChange={(event) =>
                              updateSettings({ reversals: event.target.checked })
                            }
                          />
                          <span className="switch" aria-hidden="true" />
                        </label>
                        {error && (
                          <p className="notice warning" role="alert">
                            {error}
                          </p>
                        )}
                        <button type="submit" className="button button-gold draw-button">
                          <Icon name="spark" /> Draw Cards{' '}
                          <span className="button-count">{count}</span>
                        </button>
                        <p className="draw-note">
                          Every card has an equal chance. Every reading starts fresh.
                        </p>
                      </form>
                    </section>
                    <div className="principles">
                      <span>
                        <Icon name="moon" size={17} /> Your own quiet ritual
                      </span>
                      <span>
                        <Icon name="check" size={17} /> Secure, unbiased draws
                      </span>
                      <span>
                        <Icon name="book" size={17} />{' '}
                        {journalUid ? 'Your synced reading journal' : 'A journal on your device'}
                      </span>
                    </div>
                  </>
                )}

                {reading && (
                  <section className="reading-result" aria-label="Your reading">
                    <div className="result-heading">
                      <div>
                        <p className="eyebrow">
                          {dateLabel(reading.createdAt)} · {reading.cards.length}{' '}
                          {reading.cards.length === 1 ? 'CARD' : 'CARDS'}
                        </p>
                        <h1>Your moment, drawn.</h1>
                        <p className="reading-question">
                          {reading.question || 'An open reading. A little space to listen.'}
                        </p>
                      </div>
                      <button className="button button-secondary" onClick={newReading}>
                        <Icon name="spark" />
                        New Reading
                      </button>
                    </div>
                    <div className="reveal-bar">
                      <p role="status" aria-live="polite">
                        {revealedCount === reading.cards.length
                          ? 'Your spread is revealed. Tap a card to explore its meaning.'
                          : `${revealedCount} of ${reading.cards.length} revealed · Tap a card when you’re ready.`}
                      </p>
                      <button
                        className="text-button"
                        onClick={() => reveal()}
                        disabled={revealedCount === reading.cards.length}
                      >
                        Reveal All
                      </button>
                    </div>
                    <div
                      className={`spread-grid ${reading.cards.length === 1 ? 'single-card' : ''}`}
                    >
                      {reading.cards.map((drawn, index) => {
                        const card = CARD_BY_ID.get(drawn.cardId)!;
                        const isRevealed = reading.revealed[index];
                        return (
                          <div className="spread-slot" key={`${reading.id}-${index}`}>
                            <p className="position-label">
                              CARD {String(index + 1).padStart(2, '0')}
                            </p>
                            <button
                              className={`tarot-card ${isRevealed ? 'is-revealed' : ''}`}
                              aria-label={
                                isRevealed
                                  ? `${card.name}, ${drawn.orientation}. View card details`
                                  : `Reveal card ${index + 1}`
                              }
                              onClick={(event) => {
                                if (event.detail > 1) return;
                                isRevealed ? setDetails(index) : reveal(index);
                              }}
                            >
                              <span className="card-flipper">
                                <span className="card-face card-back" aria-hidden="true">
                                  <CardBackArtwork />
                                </span>
                                <span className="card-face card-front" aria-hidden="true">
                                  <CardArtwork
                                    card={card}
                                    reversed={drawn.orientation === 'reversed'}
                                  />
                                </span>
                              </span>
                              <span className="card-caption" aria-hidden="true">
                                <strong>{isRevealed ? card.name : 'Your card awaits'}</strong>
                                <small>{isRevealed ? drawn.orientation : 'Tap to reveal'}</small>
                              </span>
                            </button>
                            <p className="card-underlabel">
                              {isRevealed
                                ? card[drawn.orientation].keywords.slice(0, 2).join(' · ')
                                : 'Tap to reveal'}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                    <div className="reading-actions">
                      <button className="button button-secondary" onClick={copyReading}>
                        <Icon name={copied ? 'check' : 'copy'} />
                        {copied ? 'Copied Reading' : 'Copy Reading'}
                      </button>
                      <span role="status">
                        {copied
                          ? 'Ready to paste into your chat or notes.'
                          : 'Your cards stay exactly as drawn.'}
                      </span>
                    </div>
                    <p className="reflection-note">
                      {journalUid
                        ? account.status
                        : 'A prompt for reflection. You decide what resonates.'}
                    </p>
                  </section>
                )}
              </>
            }
          />
          <Route path="/deck" element={<CardLibrary />} />
          <Route element={user ? <Navigate to="/journal" replace /> : <Outlet />}>
            <Route path="/login" element={<AccountForm mode="signIn" />} />
            <Route path="/signup" element={<AccountForm mode="signUp" />} />
            <Route path="/reset-password" element={<AccountForm mode="reset" />} />
          </Route>
          <Route
            path="/journal"
            element={
              <JournalPage
                readings={readings}
                account={Boolean(journalUid)}
                loading={account.loading}
                hasMore={Boolean(journalUid && account.hasMore)}
                onLoadMore={account.loadMore}
                onOpen={openReading}
                onRequestDelete={setConfirmDelete}
                onRequestClear={() => setConfirmDelete('all')}
              >
                <AccountPanel
                  key={user?.uid ?? 'signed-out'}
                  user={user}
                  syncStatus={account.status}
                  signOutDisabled={account.pending}
                  onLock={account.trusted && journalUid ? () => lockJournal(journalUid) : undefined}
                />
                <JournalTransfer
                  accountEmail={journalUid ? (user?.email ?? null) : null}
                  recoveryReadings={account.recoveryReadings}
                  deletionStorageUnreadable={account.deletionStorageUnreadable}
                  recoveryComplete={account.recoveryComplete}
                  getRecoveryForExport={account.getRecoveryForExport}
                  savedRecovery={account.savedRecovery}
                  deviceCount={deviceCount}
                  getDeviceReadings={guestReadingsForTransfer}
                  onExport={exportJournal}
                  onPreview={previewImport}
                  onImport={importJournal}
                />
              </JournalPage>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <footer className="site-footer">
        <span>Made for a moment of reflection.</span>
        <button className="footer-status" onClick={() => setHelp(true)}>
          <Icon name={offline === 'ready' ? 'check' : 'info'} size={15} />
          {offline === 'ready'
            ? 'Ready for offline use'
            : offline === 'checking'
              ? 'Preparing offline use…'
              : offline === 'error'
                ? 'Offline setup incomplete'
                : 'Offline setup unavailable'}
        </button>
      </footer>
      {updateAvailable && (
        <p className="update-note" role="status">
          An update is cached. It will be used after all Arcana Journal windows close. Your saved
          cards will stay the same.
        </p>
      )}

      {help && (
        <Modal title="About Arcana Journal" onClose={() => setHelp(false)}>
          <div className="help-content">
            <p>
              A complete 78-card tarot deck, a private journal, and a quiet space to reflect. Free
              to use, with no account or connection needed after offline setup.
            </p>
            <h3>Fair draws, explained</h3>
            <p>
              Each reading uses cryptographically secure random draws with unbiased shuffling. Web
              Crypto supplies unsigned 32-bit values; rejection sampling removes modulo bias.
              Fisher–Yates shuffles a fresh full deck once, then takes your chosen number of cards
              without replacement.
            </p>
            <p>
              Your question, past readings, meanings, and animations never enter the selection
              algorithm. Separate readings can repeat, even in full. With reversals enabled, each
              drawn card independently gets a secure 50/50 orientation. Without Web Crypto, drawing
              stops with an error.
            </p>
            <h3>Keep it on your iPhone</h3>
            <ol>
              <li>Open the deployed HTTPS address in Safari.</li>
              <li>Tap Share, then Add to Home Screen.</li>
              <li>Enable Open as Web App if shown, then tap Add.</li>
              <li>
                Open Arcana Journal from that icon while online. Wait for “Ready for offline use”
                before disconnecting.
              </li>
            </ol>
            <p>
              Updates wait until all app windows are closed. A cached update never reloads an active
              reading.
            </p>
            <h3>Where your journal is saved</h3>
            <p>
              Guest readings stay in this browser or installed app. Sign in and verify your email on
              the Journal page to sync account readings across devices. To bring over existing
              readings, choose Import this device’s journal and review the destination. Export
              journal saves a portable backup. Anyone with the file can read its contents.
            </p>
            <h3>The deck</h3>
            <p>
              All 78 cards illustrate the traditional Rider–Waite–Smith scenes, with newly created
              artwork in a textured, colorful style. The original scenes were illustrated by Pamela
              Colman Smith for Arthur Edward Waite. Artwork and fixed upright and reversed meanings
              are bundled on your device. No image or AI service is needed to use the app.
            </p>
            <p className="help-footnote">
              Card meanings offer prompts for reflection, not promises about what will happen.
            </p>
          </div>
        </Modal>
      )}
      {selected && selectedCard && details !== null && (
        <Modal
          title={selectedCard.name}
          onClose={() => setDetails(null)}
          className="card-detail-modal"
        >
          <div className="card-detail">
            <div className="detail-art">
              <CardArtwork card={selectedCard} reversed={selected.orientation === 'reversed'} />
            </div>
            <div>
              <p className="eyebrow">
                CARD {details + 1} ·{' '}
                {selectedCard.arcana === 'major'
                  ? 'MAJOR ARCANA'
                  : selectedCard.suit?.toUpperCase()}
              </p>
              <span className="orientation-badge">{selected.orientation}</span>
              <div className="keyword-list">
                {selectedCard[selected.orientation].keywords.map((word) => (
                  <span key={word}>{word}</span>
                ))}
              </div>
              <p className="card-meaning">{selectedCard[selected.orientation].meaning}</p>
              <p className="field-hint">Notice what connects with your own experience.</p>
            </div>
          </div>
        </Modal>
      )}
      {confirmDelete && (
        <Modal
          title={confirmDelete === 'all' ? 'Clear your journal?' : 'Delete this reading?'}
          onClose={() => setConfirmDelete(null)}
        >
          {confirmDelete !== 'all' && (
            <p>
              {confirmDelete.question || 'An open reading'} · {dateLabel(confirmDelete.createdAt)}
            </p>
          )}
          <p>
            {journalUid
              ? confirmDelete === 'all'
                ? 'All readings in your account will be removed from every synced device.'
                : account.isFailedDraw(confirmDelete.id)
                  ? 'This unsynced reading will be discarded from this tab.'
                  : 'This reading will be removed from your account and every synced device.'
              : confirmDelete === 'all'
                ? 'All readings on this device will be removed.'
                : 'This reading will be removed from this device.'}{' '}
            This cannot be undone.
          </p>
          <div className="modal-actions">
            <button className="button button-secondary" onClick={() => setConfirmDelete(null)}>
              Keep {confirmDelete === 'all' ? 'Readings' : 'Reading'}
            </button>
            <button className="button button-danger" onClick={deleteReadings}>
              {confirmDelete === 'all' ? 'Clear All Readings' : 'Delete Reading'}
            </button>
          </div>
        </Modal>
      )}
      {copyText && (
        <Modal title="Copy your reading" onClose={() => setCopyText(null)}>
          <p>Your browser couldn’t access the clipboard. Select and copy the text below.</p>
          <textarea
            className="copy-fallback"
            aria-label="Reading text to copy"
            readOnly
            value={copyText}
            onFocus={(event) => event.target.select()}
            rows={12}
          />
        </Modal>
      )}
    </div>
  );
}
