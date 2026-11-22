import { act, render, screen, waitFor, within } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import userEvent from '@testing-library/user-event';
import { TestApp, TestRouter } from './test/TestRouter';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as journal from './cloud/journal';
import * as journalActivity from './cloud/journalActivity';
import { freshData, STORAGE_KEY } from './domain/storage';
import type { Reading } from './domain/types';
import { captureBackup } from './test/captureBackup';

vi.mock('./pwa', () => ({ subscribeOfflineStatus: () => () => {} }));
vi.mock('./cloud/journal', () => ({
  observeAccount: vi.fn(),
  observeReadings: vi.fn(),
  observeReading: vi.fn(),
  observePendingDeletions: vi.fn(),
  readDeletionTarget: vi.fn(),
  signIn: vi.fn(),
  signOutAccount: vi.fn(),
  signUp: vi.fn(),
  resetPassword: vi.fn(),
  refreshAccount: vi.fn(),
  sendVerification: vi.fn(),
  isOfflineJournalEnabled: vi.fn(),
  isJournalLocked: vi.fn(),
  isJournalLockedInThisTabOnly: () => false,
  observeJournalLock: vi.fn(),
  lockJournal: vi.fn(),
  unlockJournal: vi.fn(),
  createReading: vi.fn(),
  revealCards: vi.fn(),
  removeReading: vi.fn(),
  clearReadings: vi.fn(),
  reviewAccountClear: vi.fn(),
  withClearPreparation: (
    uid: string,
    prepare: Parameters<typeof journal.withClearPreparation>[1],
  ) => prepare((submitted) => journal.clearReadings(uid, submitted)),
  exportAccountJournal: vi.fn(),
  checkReadingsForPendingDeletions: vi.fn(),
  previewAccountImport: vi.fn(),
  importAccountReadings: vi.fn(),
}));

const firstUser = { uid: 'one', email: 'first@example.test', emailVerified: true };
const nextUser = { uid: 'two', email: 'second@example.test', emailVerified: true };
const reading = (id: string, question: string): Reading => ({
  id,
  question,
  createdAt: '2026-11-19T12:00:00.000Z',
  cards: [
    { cardId: 'major-00', orientation: 'upright' },
    { cardId: 'major-01', orientation: 'reversed' },
  ],
  revealed: [false, true],
});
const deviceReading = reading('legacy', 'Before I opened an account');
const firstReading = reading('account-one', 'A question for my first account');
const nextReading = reading('account-two', 'A question for my second account');
const synced = { fromCache: false, pending: false, hasMore: false };
const mount = (path = '/journal') =>
  render(
    <TestRouter path={path}>
      <TestApp />
    </TestRouter>,
  );
const goToJournal = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('link', { name: /^Journal/ }));
const cloud = vi.mocked(journal);
let signedIn: journal.JournalUser | null;
let accountListener: Parameters<typeof journal.observeAccount>[0];
const activeListeners = new Set<() => void>();
const records = new Map<string, Reading[]>();

const setAccount = (account: journal.JournalUser | null) => {
  signedIn = account;
  accountListener(account);
};
const publish = (uid: string, readings: Reading[]) => {
  records.set(uid, readings);
  for (const notify of activeListeners) notify();
};

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...freshData(), readings: [deviceReading] }));
  activeListeners.clear();
  records.clear();
  records.set(firstUser.uid, [firstReading]);
  records.set(nextUser.uid, [nextReading]);
  signedIn = null;
  cloud.isJournalLocked.mockReturnValue(false);
  cloud.observeJournalLock.mockImplementation(() => () => {});
  cloud.observePendingDeletions.mockImplementation(() => () => {});
  cloud.observeAccount.mockImplementation((listener) => {
    accountListener = listener;
    listener(signedIn);
    return () => {};
  });
  cloud.observeReadings.mockImplementation((uid, count, listener) => {
    const notify = () => {
      const entries = records.get(uid)!;
      listener(entries.slice(0, count), { ...synced, hasMore: entries.length > count });
    };
    activeListeners.add(notify);
    notify();
    return () => {
      activeListeners.delete(notify);
    };
  });
  cloud.observeReading.mockImplementation((uid, id, listener) => {
    const notify = () => listener(records.get(uid)?.find((item) => item.id === id) ?? null);
    activeListeners.add(notify);
    notify();
    return () => {
      activeListeners.delete(notify);
    };
  });
  cloud.signIn.mockImplementation(async (email) =>
    setAccount(email === firstUser.email ? firstUser : nextUser),
  );
  cloud.signOutAccount.mockImplementation(async () => setAccount(null));
});

describe('the public view before account restoration', () => {
  it.each(['/', '/login', '/signup', '/reset-password'])(
    'keeps form inputs disabled in the initial HTML for %s',
    (path) => {
      const readStorage = vi.spyOn(Storage.prototype, 'getItem');
      const container = document.createElement('div');
      container.innerHTML = renderToString(
        <TestRouter path={path}>
          <TestApp />
        </TestRouter>,
      );
      const form = container.querySelector('form')!;
      expect(form.querySelector('button[type="submit"]')).toBeDisabled();
      for (const field of form.querySelectorAll('input, textarea, select')) {
        expect(field).toBeDisabled();
      }
      expect(readStorage).not.toHaveBeenCalled();
      expect(cloud.observeAccount).not.toHaveBeenCalled();
    },
  );

  it('hydrates the shared journal HTML without revealing or reading a guest journal before identity is known', async () => {
    cloud.observeAccount.mockImplementation((listener) => {
      accountListener = listener;
      return () => {};
    });
    const page = (
      <TestRouter path="/journal">
        <TestApp />
      </TestRouter>
    );
    const readStorage = vi.spyOn(Storage.prototype, 'getItem');
    const container = document.createElement('div');
    container.innerHTML = renderToString(page);
    document.body.appendChild(container);
    const onRecoverableError = vi.fn();
    render(page, { container, hydrate: true, onRecoverableError });
    expect(screen.getByRole('heading', { name: 'Your reading journal.' })).toBeVisible();
    expect(screen.queryByText(deviceReading.question)).toBeNull();
    expect(readStorage).not.toHaveBeenCalled();
    expect(cloud.observeReadings).not.toHaveBeenCalled();
    expect(onRecoverableError).not.toHaveBeenCalled();

    act(() => setAccount(firstUser));
    expect(await screen.findByRole('heading', { name: firstReading.question })).toBeVisible();
    expect(screen.queryByText(deviceReading.question)).toBeNull();
  });
});

describe('account journal workflows', () => {
  it('requires a complete account inventory before a clear can be confirmed', async () => {
    const user = userEvent.setup();
    signedIn = firstUser;
    let failReview!: (error: Error) => void;
    cloud.reviewAccountClear.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failReview = reject;
        }),
    );
    mount();
    await user.click(await screen.findByRole('button', { name: 'Clear History' }));
    const confirm = screen.getByRole('button', { name: 'Clear All Readings' });
    expect(confirm).toBeDisabled();
    await act(async () => failReview(new Error('Connect to load the remaining readings.')));
    expect(screen.getByText('Connect to load the remaining readings.')).toBeVisible();
    expect(confirm).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Keep Readings' }));
    expect(cloud.clearReadings).not.toHaveBeenCalled();
  });
  it('opens signup from the main sign-in link and creates a trusted account after confirming the password', async () => {
    const user = userEvent.setup();
    cloud.signUp.mockImplementation(async () => setAccount({ ...firstUser, emailVerified: false }));
    mount('/');
    const signInLink = within(screen.getByRole('banner')).getByRole('link', { name: 'Sign in' });
    await user.click(signInLink);
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await user.click(
      within(screen.getByRole('main')).getByRole('link', { name: 'Create account' }),
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Create account' })).toBeVisible();
    await user.type(screen.getByLabelText('Email address'), firstUser.email);
    await user.type(screen.getByLabelText('Password', { exact: true }), 'test-password');
    const confirmation = screen.getByLabelText('Confirm password');
    await user.type(confirmation, 'wrong-password');
    const submit = screen.getByRole('button', { name: 'Create account' });
    await user.click(submit);
    expect(screen.getByRole('alert')).toHaveTextContent(/match/i);
    expect(cloud.signUp).not.toHaveBeenCalled();
    await user.clear(confirmation);
    await user.type(confirmation, 'test-password');
    const trust = screen.getByRole('checkbox');
    expect(trust).not.toBeChecked();
    await user.click(trust);
    await user.click(submit);
    expect(cloud.signUp).toHaveBeenCalledWith(firstUser.email, 'test-password', true);
    expect(await screen.findByRole('heading', { name: 'Your reading journal.' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Check verification' })).toBeVisible();
    expect(screen.getByRole('heading', { name: deviceReading.question })).toBeVisible();
    expect(cloud.observeReadings).not.toHaveBeenCalled();
  });

  it('offers recovery after a rejected signup without confirming who has registered', async () => {
    const user = userEvent.setup();
    cloud.signUp.mockRejectedValueOnce({ code: 'auth/email-already-in-use' });
    mount('/signup');
    await user.type(screen.getByLabelText('Email address'), firstUser.email);
    await user.type(screen.getByLabelText('Password', { exact: true }), 'test-password');
    await user.type(screen.getByLabelText('Confirm password'), 'test-password');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We couldn’t create an account with those details. Try signing in or resetting your password.',
    );
    expect(cloud.observeReadings).not.toHaveBeenCalled();
  });

  it.each(['auth/invalid-credential', 'auth/user-disabled'])(
    'recovers from rejected credentials (%s) through the password reset page',
    async (code) => {
      const user = userEvent.setup();
      cloud.signIn.mockRejectedValueOnce({ code });
      mount('/login');
      await user.type(screen.getByLabelText('Email address'), firstUser.email);
      await user.type(screen.getByLabelText('Password'), 'old-password');
      await user.click(screen.getByRole('button', { name: 'Sign in' }));
      expect(cloud.signIn).toHaveBeenCalledWith(firstUser.email, 'old-password', false);
      expect(await screen.findByRole('alert')).toHaveTextContent(/check your email/i);
      await user.click(screen.getByRole('link', { name: 'Forgot password?' }));
      expect(screen.getByRole('heading', { level: 1, name: 'Reset password' })).toBeVisible();
      expect(screen.getByLabelText('Email address')).toHaveValue(firstUser.email);
      if (code === 'auth/user-disabled') cloud.resetPassword.mockRejectedValueOnce({ code });
      await user.click(screen.getByRole('button', { name: 'Send reset email' }));
      expect(cloud.resetPassword).toHaveBeenCalledWith(firstUser.email);
      expect(await screen.findByRole('status')).toHaveTextContent(firstUser.email);
      await user.click(screen.getByRole('link', { name: 'Back to sign in' }));
      expect(screen.getByLabelText('Password')).toHaveValue('');
    },
  );

  it.each(['/login', '/signup', '/reset-password'])(
    'opens the journal for an existing session at %s',
    async (path) => {
      signedIn = firstUser;
      mount(path);
      expect(
        await screen.findByRole('heading', { level: 1, name: 'Your reading journal.' }),
      ).toBeVisible();
      expect(screen.getByRole('heading', { name: firstUser.email })).toBeVisible();
    },
  );

  it('keeps unverified accounts in the guest journal and imports only after verification and confirmation', async () => {
    const user = userEvent.setup();
    const original = localStorage.getItem(STORAGE_KEY);
    cloud.signIn.mockImplementation(async () => setAccount({ ...firstUser, emailVerified: false }));
    cloud.refreshAccount.mockImplementation(async () => {
      setAccount(firstUser);
      return firstUser;
    });
    cloud.previewAccountImport.mockResolvedValue({ added: 1, updated: 0, skipped: 0 });
    cloud.importAccountReadings.mockImplementation(async (uid, entries) => {
      publish(uid, [...records.get(uid)!, ...entries]);
      return { added: 1, updated: 0, skipped: 0 };
    });
    mount();
    expect(screen.getByRole('heading', { name: deviceReading.question })).toBeVisible();
    await user.click(within(screen.getByRole('main')).getByRole('link', { name: 'Sign in' }));
    const form = within(screen.getByRole('main'));
    await user.type(form.getByLabelText('Email address'), firstUser.email);
    await user.type(form.getByLabelText('Password'), 'test-password');
    await user.click(form.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: firstUser.email })).toBeVisible();
    expect(screen.getByRole('heading', { name: deviceReading.question })).toBeVisible();
    expect(screen.queryByRole('heading', { name: firstReading.question })).toBeNull();
    expect(screen.queryByRole('button', { name: /Import this device/ })).toBeNull();
    expect(cloud.observeReadings).not.toHaveBeenCalled();
    expect(cloud.observeReading).not.toHaveBeenCalled();
    expect(cloud.previewAccountImport).not.toHaveBeenCalled();
    expect(cloud.importAccountReadings).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Check verification' }));
    expect(await screen.findByRole('heading', { name: firstReading.question })).toBeVisible();
    expect(screen.queryByRole('heading', { name: deviceReading.question })).toBeNull();
    expect(cloud.importAccountReadings).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /Import this device/ }));
    const preview = within(await screen.findByRole('dialog', { name: 'Review journal import' }));
    expect(preview.getByText(firstUser.email)).toBeVisible();
    expect(cloud.previewAccountImport.mock.lastCall?.slice(0, 2)).toEqual([
      firstUser.uid,
      [deviceReading],
    ]);
    expect(cloud.importAccountReadings).not.toHaveBeenCalled();
    await user.click(preview.getByRole('button', { name: 'Confirm import' }));
    expect(await screen.findByRole('heading', { name: deviceReading.question })).toBeVisible();
    expect(localStorage.getItem(STORAGE_KEY)).toBe(original);
    const previousListener = cloud.observeReadings.mock.lastCall![2];
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(screen.queryByRole('heading', { name: firstReading.question })).toBeNull();
    expect(screen.getByRole('heading', { name: deviceReading.question })).toBeVisible();
    act(() => setAccount(nextUser));
    // A callback already queued by the old session must not cross the account boundary.
    act(() => previousListener([firstReading], synced));
    expect(screen.getByRole('heading', { name: nextReading.question })).toBeVisible();
    expect(screen.queryByRole('heading', { name: firstReading.question })).toBeNull();
    expect(screen.queryByRole('heading', { name: deviceReading.question })).toBeNull();
  });

  it('downloads and previews unsaved guest changes after signing in even when another tab changed the journal', async () => {
    const user = userEvent.setup();
    const backup = captureBackup();
    cloud.previewAccountImport.mockResolvedValue({ added: 2, updated: 0, skipped: 0 });
    const sibling = reading('sibling', 'Saved in another guest tab');
    try {
      mount();
      await user.click(screen.getByRole('button', { name: /^Open reading:/ }));
      const rejectWrite = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      });
      await user.click(screen.getByRole('button', { name: 'Reveal card 1' }));
      expect(
        await screen.findByText(/your cards are still available in this session/i),
      ).toBeVisible();
      rejectWrite.mockRestore();
      const saved = JSON.stringify({ ...freshData(), readings: [sibling] });
      localStorage.setItem(STORAGE_KEY, saved);
      act(() => setAccount(firstUser));
      await goToJournal(user);
      await user.click(screen.getByRole('button', { name: 'Download guest backup' }));
      expect(await screen.findByRole('link', { name: 'Download backup' })).toHaveAttribute(
        'download',
        expect.stringContaining('-guest-'),
      );
      const file = await backup();
      const edited = { ...deviceReading, revealed: [true, true] };
      expect(file.readings).toHaveLength(2);
      expect(file.readings).toEqual(expect.arrayContaining([edited, sibling]));
      expect(cloud.exportAccountJournal).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: /Import this device/ }));
      const dialog = within(await screen.findByRole('dialog', { name: 'Review journal import' }));
      expect(dialog.getByText(firstUser.email)).toBeVisible();
      expect(cloud.previewAccountImport.mock.lastCall?.slice(0, 2)).toEqual([
        firstUser.uid,
        file.readings,
      ]);
      expect(cloud.importAccountReadings).not.toHaveBeenCalled();
      expect(localStorage.getItem(STORAGE_KEY)).toBe(saved);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it('draws into the account, restores a remote reveal in a second session, and deletes across devices', async () => {
    const user = userEvent.setup();
    const guestBefore = localStorage.getItem(STORAGE_KEY);
    signedIn = firstUser;
    cloud.createReading.mockImplementation(async (uid, entry) =>
      publish(uid, [entry, ...records.get(uid)!]),
    );
    cloud.revealCards.mockImplementation(async (uid, reading, indexes) => {
      publish(
        uid,
        records.get(uid)!.map((entry) =>
          entry.id === reading.id
            ? {
                ...entry,
                revealed: entry.revealed.map((shown, index) => shown || indexes.includes(index)),
              }
            : entry,
        ),
      );
    });
    cloud.removeReading.mockImplementation(async (uid, target) =>
      publish(
        uid,
        records.get(uid)!.filter((entry) => entry.id !== target.id),
      ),
    );
    const app = mount('/');
    await user.type(screen.getByLabelText(/What’s on your mind/), 'A reading across devices');
    await user.click(screen.getByRole('button', { name: /Draw Cards/ }));
    const [uid, drawn] = cloud.createReading.mock.calls[0];
    expect(uid).toBe(firstUser.uid);
    expect(drawn.revealed).toEqual([false, false, false]);
    await user.click(screen.getByRole('button', { name: 'Reveal card 1' }));
    expect(cloud.revealCards).toHaveBeenCalledWith(uid, drawn, [0]);
    expect(screen.getAllByRole('button', { name: /View card details/ })).toHaveLength(1);
    app.unmount();
    sessionStorage.clear(); // Another tab starts with its own current spread.
    const remote = { ...drawn, revealed: [true, true, false] };
    records.set(uid, [remote, firstReading]);
    mount();
    await user.click(
      screen.getByRole('button', { name: /^Open reading: A reading across devices/ }),
    );
    expect(screen.getAllByRole('button', { name: /View card details/ })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Reveal card 3' })).toBeVisible();
    expect(cloud.createReading).toHaveBeenCalledTimes(1);
    await goToJournal(user);
    await user.click(
      screen.getByRole('button', { name: 'Delete reading: A reading across devices' }),
    );
    const dialog = within(screen.getByRole('dialog', { name: 'Delete this reading?' }));
    expect(dialog.getByText(/every synced device/)).toBeVisible();
    await user.click(dialog.getByRole('button', { name: 'Delete Reading' }));
    expect(cloud.removeReading).toHaveBeenCalledWith(uid, remote);
    expect(screen.queryByRole('heading', { name: drawn.question })).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBe(guestBefore);
  });

  it('saves an instantly revealed account spread in the initial draw', async () => {
    const user = userEvent.setup();
    signedIn = firstUser;
    cloud.createReading.mockImplementation(async (uid, entry) =>
      publish(uid, [entry, ...records.get(uid)!]),
    );
    const app = mount('/');
    await user.click(screen.getByRole('checkbox', { name: /Reveal cards instantly/ }));
    app.unmount();
    mount('/');
    expect(screen.getByRole('checkbox', { name: /Reveal cards instantly/ })).toBeChecked();
    await user.click(screen.getByRole('button', { name: /Draw Cards/ }));

    expect(screen.getAllByRole('button', { name: /View card details/ })).toHaveLength(3);
    expect(cloud.createReading).toHaveBeenCalledWith(
      firstUser.uid,
      expect.objectContaining({ revealed: [true, true, true] }),
    );
    expect(cloud.revealCards).not.toHaveBeenCalled();
  });

  it('dismisses a pending delete when a sibling locks the journal', async () => {
    const user = userEvent.setup();
    signedIn = firstUser;
    let lockChanged!: () => void;
    cloud.observeJournalLock.mockImplementation((_uid, notify) => {
      lockChanged = notify;
      return () => {};
    });
    mount();
    await user.click(
      screen.getByRole('button', { name: 'Delete reading: ' + firstReading.question }),
    );
    expect(screen.getByRole('dialog')).toHaveTextContent(firstReading.question);
    act(() => {
      cloud.isJournalLocked.mockReturnValue(true);
      lockChanged();
    });
    expect(screen.getByRole('heading', { name: 'Journal locked' })).toBeVisible();
    const replacement = { ...firstReading, question: 'Another reading at the original ID' };
    act(() => {
      publish(firstUser.uid, [replacement]);
      cloud.isJournalLocked.mockReturnValue(false);
      lockChanged();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { name: replacement.question })).toBeVisible();
    expect(cloud.removeReading).not.toHaveBeenCalled();
  });

  it('keeps a confirmed row hidden through stale snapshots and shows a later reimport', async () => {
    const user = userEvent.setup();
    signedIn = firstUser;
    const other = reading('other', 'A reading I am keeping');
    const cached = { ...synced, fromCache: true };
    let snapshot!: Parameters<typeof journal.observeReadings>[2];
    cloud.observeReadings.mockImplementation((_uid, _count, listener) => {
      snapshot = listener;
      listener([firstReading, other], cached);
      return () => {};
    });
    let acknowledge!: () => void;
    cloud.removeReading.mockReturnValueOnce(
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
    );
    mount();
    await user.click(
      screen.getByRole('button', { name: 'Delete reading: ' + firstReading.question }),
    );
    const row = () => screen.queryByRole('heading', { name: firstReading.question });
    expect(row()).toBeVisible();
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete Reading' }),
    );
    expect(row()).toBeNull();
    expect(screen.getByRole('heading', { name: other.question })).toBeVisible();

    const queue = cloud.observePendingDeletions.mock.lastCall![1];
    act(() => queue([{ key: 'delete-first', reading: firstReading, durable: true }]));
    const replacement = { ...firstReading, question: 'A different spread with the same ID' };
    act(() => snapshot([replacement, other], cached));
    expect(screen.getByRole('heading', { name: replacement.question })).toBeVisible();
    act(() => snapshot([firstReading, other], cached));
    expect(row()).toBeNull();

    act(() => queue([]));
    expect(row()).toBeNull();
    await act(async () => acknowledge());
    expect(row()).toBeNull();
    act(() => snapshot([other], cached));
    act(() => snapshot([firstReading, other], cached));
    expect(row()).toBeNull();
    act(() => snapshot([other], synced));
    expect(row()).toBeNull();
    act(() => snapshot([firstReading, other], synced));
    expect(row()).toBeVisible();
  });

  it('hides a replayed deletion until a fresh subscription confirms a reimport', async () => {
    signedIn = firstUser;
    const cached = { ...synced, fromCache: true };
    cloud.observeReadings.mockImplementation((_uid, _count, listener) => {
      listener([firstReading], cached);
      return () => {};
    });
    mount();
    const row = () => screen.queryByRole('heading', { name: firstReading.question });
    const queue = cloud.observePendingDeletions.mock.lastCall![1];
    const previousSnapshot = cloud.observeReadings.mock.lastCall![2];
    act(() => queue([{ key: 'replayed', reading: firstReading, durable: true }]));
    expect(row()).toBeNull();
    act(() => queue([]));
    expect(row()).toBeNull();
    act(() => previousSnapshot([firstReading], synced));
    expect(row()).toBeNull();
    const freshSnapshot = cloud.observeReadings.mock.lastCall![2];
    await act(async () => freshSnapshot([firstReading], synced));
    expect(row()).toBeVisible();
    expect(cloud.removeReading).not.toHaveBeenCalled();
  });

  it('requires a new confirmation when the selected reading is replaced while the dialog is open', async () => {
    const user = userEvent.setup();
    signedIn = firstUser;
    mount();
    await user.click(
      screen.getByRole('button', { name: 'Delete reading: ' + firstReading.question }),
    );
    const updated = { ...firstReading, revealed: [true, true] };
    act(() => publish(firstUser.uid, [updated]));
    expect(screen.getByRole('dialog', { name: 'Delete this reading?' })).toBeVisible();
    const replacement = { ...firstReading, question: 'Replacement under the same ID' };
    act(() => publish(firstUser.uid, [replacement]));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(cloud.removeReading).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole('button', { name: 'Delete reading: ' + replacement.question }),
    );
    expect(screen.getByRole('dialog')).toHaveTextContent(replacement.question);
  });

  it.each(['clear', 'unknown'] as const)(
    'exports every page and labels the file when sibling activity is %s',
    async (siblingState) => {
      const user = userEvent.setup();
      signedIn = firstUser;
      const checkOtherTabs = vi
        .spyOn(journalActivity, 'checkSiblingRecovery')
        .mockResolvedValue(siblingState);
      const readings = Array.from({ length: 51 }, (_, index) =>
        reading('entry-' + index, 'Reading ' + index),
      );
      records.set(firstUser.uid, readings);
      cloud.exportAccountJournal.mockResolvedValue(JSON.stringify({ version: 1, readings }));
      const createURL = vi.fn((_file: Blob) => 'blob:account-export');
      vi.stubGlobal(
        'URL',
        class extends URL {
          static createObjectURL = createURL;
          static revokeObjectURL = vi.fn();
        },
      );
      const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      try {
        mount();
        expect(screen.queryByRole('heading', { name: 'Reading 50' })).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Export journal' }));
        expect(await screen.findByRole('link', { name: 'Download backup' })).toHaveAttribute(
          'href',
          'blob:account-export',
        );
        expect(cloud.exportAccountJournal).toHaveBeenCalledWith(
          firstUser.uid,
          false,
          expect.any(Function),
        );
        const filename = screen
          .getByRole('link', { name: 'Download backup' })
          .getAttribute('download');
        expect(filename).toContain('cloud-and-this-tab');
        expect(screen.getByText(/Other tabs may have unsynced readings/)).toBeVisible();
        const blob = createURL.mock.calls[0][0];
        const json = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.readAsText(blob);
        });
        expect(JSON.parse(json).readings).toEqual(readings);
        await user.click(screen.getByRole('button', { name: 'Load older readings' }));
        expect(screen.getByRole('heading', { name: 'Reading 50' })).toBeVisible();
      } finally {
        checkOtherTabs.mockRestore();
        download.mockRestore();
        vi.unstubAllGlobals();
      }
    },
  );

  it.each(['clear', 'lock', 'sign out', 'pagehide'])(
    'drops the previous account export when a delayed response arrives after %s',
    async (action) => {
      const user = userEvent.setup();
      signedIn = firstUser;
      let notifyLock!: () => void;
      cloud.observeJournalLock.mockImplementation((_uid, notify) => {
        notifyLock = notify;
        return () => {};
      });
      const checkOtherTabs = vi
        .spyOn(journalActivity, 'checkSiblingRecovery')
        .mockResolvedValue('clear');
      let finishExport!: (json: string) => void;
      cloud.exportAccountJournal.mockReturnValueOnce(
        new Promise((resolve) => {
          finishExport = resolve;
        }),
      );
      const currentReadings =
        action === 'clear' ? [] : [action === 'sign out' ? nextReading : firstReading];
      cloud.exportAccountJournal.mockResolvedValue(
        JSON.stringify({ version: 1, readings: currentReadings }),
      );
      const currentBackup = captureBackup();
      try {
        mount();
        await user.click(screen.getByRole('button', { name: 'Export journal' }));
        await waitFor(() => expect(cloud.exportAccountJournal).toHaveBeenCalledTimes(1));
        if (action === 'clear') {
          cloud.reviewAccountClear.mockResolvedValueOnce({ uid: firstUser.uid, documents: [] });
          cloud.clearReadings.mockImplementationOnce(async () => publish(firstUser.uid, []));
          await user.click(screen.getByRole('button', { name: 'Clear History' }));
          await user.click(await screen.findByRole('button', { name: 'Clear All Readings' }));
          await waitFor(() => expect(cloud.clearReadings).toHaveBeenCalledTimes(1));
        } else if (action === 'lock') {
          act(() => {
            cloud.isJournalLocked.mockReturnValue(true);
            notifyLock();
          });
          expect(screen.getByRole('heading', { name: 'Journal locked' })).toBeVisible();
        } else if (action === 'pagehide') {
          act(() => {
            window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
            window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
          });
        } else {
          await user.click(screen.getByRole('button', { name: 'Sign out' }));
          act(() => setAccount(nextUser));
          expect(screen.getByRole('heading', { name: nextUser.email })).toBeVisible();
        }
        await act(async () =>
          finishExport(JSON.stringify({ version: 1, readings: [firstReading] })),
        );
        expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
        expect(screen.queryByRole('link', { name: 'Download backup' })).toBeNull();
        if (action === 'lock')
          act(() => {
            cloud.isJournalLocked.mockReturnValue(false);
            notifyLock();
          });
        await user.click(screen.getByRole('button', { name: 'Export journal' }));
        await screen.findByRole('link', { name: 'Download backup' });
        expect((await currentBackup()).readings).toEqual(currentReadings);
      } finally {
        checkOtherTabs.mockRestore();
        vi.unstubAllGlobals();
        vi.mocked(HTMLAnchorElement.prototype.click).mockRestore();
      }
    },
  );

  it('stops the download if another tab acquires unsynced readings during export', async () => {
    const user = userEvent.setup();
    signedIn = firstUser;
    const checkOtherTabs = vi
      .spyOn(journalActivity, 'checkSiblingRecovery')
      .mockResolvedValueOnce('clear')
      .mockResolvedValueOnce('busy');
    cloud.exportAccountJournal.mockResolvedValue(
      JSON.stringify({ version: 1, readings: [firstReading] }),
    );
    try {
      mount();
      await user.click(screen.getByRole('button', { name: 'Export journal' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        /another tab has unsynced journal changes/i,
      );
      expect(screen.queryByRole('link', { name: 'Download backup' })).toBeNull();
    } finally {
      checkOtherTabs.mockRestore();
    }
  });
});
