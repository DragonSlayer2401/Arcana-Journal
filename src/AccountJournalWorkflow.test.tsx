import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import * as journal from './cloud/journal';
import { freshData, STORAGE_KEY } from './domain/storage';
import type { Reading } from './domain/types';

vi.mock('./pwa', () => ({ subscribeOfflineStatus: () => () => {} }));
vi.mock('./cloud/journal', () => ({
  observeAccount: vi.fn(),
  observeReadings: vi.fn(),
  observeReading: vi.fn(),
  signIn: vi.fn(),
  signOutAccount: vi.fn(),
  signUp: vi.fn(),
  resetPassword: vi.fn(),
  refreshAccount: vi.fn(),
  sendVerification: vi.fn(),
  isOfflineJournalEnabled: vi.fn(),
  createReading: vi.fn(),
  revealCards: vi.fn(),
  removeReading: vi.fn(),
  clearReadings: vi.fn(),
  exportAccountJournal: vi.fn(),
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
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
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

describe('account journal workflows', () => {
  it('imports a guest journal only after confirming the destination and isolates subsequent logins', async () => {
    const user = userEvent.setup();
    const original = localStorage.getItem(STORAGE_KEY);
    cloud.previewAccountImport.mockResolvedValue({ added: 1, updated: 0, skipped: 0 });
    cloud.importAccountReadings.mockImplementation(async (uid, entries) => {
      publish(uid, [...records.get(uid)!, ...entries]);
      return { added: 1, updated: 0, skipped: 0 };
    });
    mount();
    expect(screen.getByRole('heading', { name: deviceReading.question })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    const form = within(screen.getByRole('dialog', { name: 'Sign in' }));
    await user.type(form.getByLabelText('Email address'), firstUser.email);
    await user.type(form.getByLabelText('Password'), 'test-password');
    await user.click(form.getByRole('button', { name: 'Sign in' }));
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

  it('draws into the account, restores a remote reveal in a second session, and deletes across devices', async () => {
    const user = userEvent.setup();
    const guestBefore = localStorage.getItem(STORAGE_KEY);
    signedIn = firstUser;
    cloud.createReading.mockImplementation(async (uid, entry) =>
      publish(uid, [entry, ...records.get(uid)!]),
    );
    cloud.revealCards.mockImplementation(async (uid, id, indexes) => {
      publish(
        uid,
        records.get(uid)!.map((entry) =>
          entry.id === id
            ? {
                ...entry,
                revealed: entry.revealed.map((shown, index) => shown || indexes.includes(index)),
              }
            : entry,
        ),
      );
    });
    cloud.removeReading.mockImplementation(async (uid, id) =>
      publish(
        uid,
        records.get(uid)!.filter((entry) => entry.id !== id),
      ),
    );
    const app = mount('/');
    await user.type(screen.getByLabelText(/What’s on your mind/), 'A reading across devices');
    await user.click(screen.getByRole('button', { name: /Draw Cards/ }));
    const [uid, drawn] = cloud.createReading.mock.calls[0];
    expect(uid).toBe(firstUser.uid);
    expect(drawn.revealed).toEqual([false, false, false]);
    await user.click(screen.getByRole('button', { name: 'Reveal card 1' }));
    expect(cloud.revealCards).toHaveBeenCalledWith(uid, drawn.id, [0]);
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
    expect(cloud.removeReading).toHaveBeenCalledWith(uid, drawn.id);
    expect(screen.queryByRole('heading', { name: drawn.question })).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBe(guestBefore);
  });

  it('requests the complete account backup while the journal is showing only the first page', async () => {
    const user = userEvent.setup();
    signedIn = firstUser;
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
      expect(cloud.exportAccountJournal).toHaveBeenCalledWith(firstUser.uid);
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
      download.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
