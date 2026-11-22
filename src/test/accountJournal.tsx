import './browser/exclusiveLocks';
import { render, screen } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';
import { beforeEach, vi } from 'vitest';
import * as account from '@/services/Account/account.service';
import * as journal from '@/services/Journal/journal.service';
import { freshData } from '@/features/Journal/utils/journalData';
import { guestStorageKey } from '@/features/Journal/features/GuestJournal/utils/guestStorage';
import type { Reading } from '@/features/Journal/readingTypes';
import { TestApp, TestRouter } from './TestRouter';

vi.mock('@/utils/pwa', () => ({ subscribeOfflineStatus: () => () => {} }));
vi.mock('@/services/Account/account.service', () => ({
  observeAccount: vi.fn(),
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
}));
vi.mock('@/services/Journal/journal.service', () => ({
  observeReadings: vi.fn(),
  observeReading: vi.fn(),
  observePendingDeletions: vi.fn(),
  readDeletionTarget: vi.fn(),
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

export const firstUser = { uid: 'one', email: 'first@example.test', emailVerified: true };
export const nextUser = { uid: 'two', email: 'second@example.test', emailVerified: true };
export const buildReading = (id: string, question: string): Reading => ({
  id,
  question,
  createdAt: '2026-11-19T12:00:00.000Z',
  cards: [
    { cardId: 'major-00', orientation: 'upright' },
    { cardId: 'major-01', orientation: 'reversed' },
  ],
  revealed: [false, true],
});
export const deviceReading = buildReading('legacy', 'Before I opened an account');
export const firstReading = buildReading('account-one', 'A question for my first account');
export const nextReading = buildReading('account-two', 'A question for my second account');
export const synced = { fromCache: false, pending: false, hasMore: false };
export const mount = (path = '/journal') =>
  render(
    <TestRouter path={path}>
      <TestApp />
    </TestRouter>,
  );
export const goToJournal = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('link', { name: /^Journal/ }));
export const mockAccount = vi.mocked(account);
export const mockJournal = vi.mocked(journal);
let signedIn: account.JournalUser | null;
let accountListener: Parameters<typeof account.observeAccount>[0];
export const restoreAccountOnMount = (user: account.JournalUser) => {
  signedIn = user;
};
const activeListeners = new Set<() => void>();
export const records = new Map<string, Reading[]>();

export const setAccount = (user: account.JournalUser | null) => {
  signedIn = user;
  accountListener(user);
};
export const publish = (uid: string, readings: Reading[]) => {
  records.set(uid, readings);
  for (const notify of activeListeners) notify();
};

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(
    guestStorageKey,
    JSON.stringify({ ...freshData(), readings: [deviceReading] }),
  );
  activeListeners.clear();
  records.clear();
  records.set(firstUser.uid, [firstReading]);
  records.set(nextUser.uid, [nextReading]);
  signedIn = null;
  mockAccount.isJournalLocked.mockReturnValue(false);
  mockAccount.observeJournalLock.mockImplementation(() => () => {});
  mockJournal.observePendingDeletions.mockImplementation(() => () => {});
  mockAccount.observeAccount.mockImplementation((listener) => {
    accountListener = listener;
    listener(signedIn);
    return () => {};
  });
  mockJournal.observeReadings.mockImplementation((uid, count, listener) => {
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
  mockJournal.observeReading.mockImplementation((uid, id, listener) => {
    const notify = () => listener(records.get(uid)?.find((item) => item.id === id) ?? null);
    activeListeners.add(notify);
    notify();
    return () => {
      activeListeners.delete(notify);
    };
  });
  mockAccount.signIn.mockImplementation(async (email) =>
    setAccount(email === firstUser.email ? firstUser : nextUser),
  );
  mockAccount.signOutAccount.mockImplementation(async () => setAccount(null));
});
