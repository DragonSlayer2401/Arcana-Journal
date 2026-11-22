import { beforeEach, vi } from 'vitest';
import { isOfflineJournalEnabled } from '@/services/Account/account.service';
import { clearReadings, observeReadings } from '@/services/Journal/journal.service';
import type { Reading } from '@/features/Journal/readingTypes';

vi.mock('@/services/Account/account.service', () => ({ isOfflineJournalEnabled: vi.fn() }));
vi.mock('@/services/Journal/journal.service', () => ({
  clearReadings: vi.fn(),
  withClearPreparation: (
    uid: string,
    prepare: Parameters<
      typeof import('@/services/Journal/journal.service').withClearPreparation
    >[1],
  ) => prepare((submitted) => clearReadings(uid, submitted)),
  createReading: vi.fn(),
  lookupRecoveryReading: vi.fn(),
  lookupRecoveryImportTarget: vi.fn(),
  observePendingDeletions: () => () => {},
  readDeletionTarget: vi.fn(),
  observeReading: () => () => {},
  observeReadings: vi.fn(),
  removeReading: vi.fn(),
  revealCards: vi.fn(),
}));

export const draw: Reading = {
  id: 'new-spread',
  question: 'A question only this device has',
  createdAt: '2026-10-02T11:11:11Z',
  cards: [
    { cardId: 'major-01', orientation: 'reversed' },
    { cardId: 'major-02', orientation: 'upright' },
  ],
  revealed: [false, false],
};

export const trustedCache = (readings: Reading[]) => {
  vi.mocked(isOfflineJournalEnabled).mockReturnValue(true);
  vi.mocked(observeReadings).mockImplementation((_uid, _limit, onChange) => {
    onChange(readings, { fromCache: true, pending: false, hasMore: false });
    return () => {};
  });
};

export const pendingWrite = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, deny) => {
    resolve = accept;
    reject = deny;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  vi.mocked(isOfflineJournalEnabled).mockReturnValue(false);
  vi.mocked(observeReadings).mockReturnValue(() => {});
});
