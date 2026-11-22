import {
  mockAccount,
  mockJournal,
  firstUser,
  buildReading,
  firstReading,
  synced,
  mount,
  publish,
  restoreAccountOnMount,
} from '@/test/accountJournal';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

describe('deleting synced readings', () => {
  it('requires a complete account inventory before a clear can be confirmed', async () => {
    const user = userEvent.setup();
    restoreAccountOnMount(firstUser);
    let failReview!: (error: Error) => void;
    mockJournal.reviewAccountClear.mockImplementationOnce(
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
    expect(mockJournal.clearReadings).not.toHaveBeenCalled();
  });
  it('dismisses a pending delete when a sibling locks the journal', async () => {
    const user = userEvent.setup();
    restoreAccountOnMount(firstUser);
    let lockChanged!: () => void;
    mockAccount.observeJournalLock.mockImplementation((_uid, notify) => {
      lockChanged = notify;
      return () => {};
    });
    mount();
    await user.click(
      screen.getByRole('button', { name: 'Delete reading: ' + firstReading.question }),
    );
    expect(screen.getByRole('dialog')).toHaveTextContent(firstReading.question);
    act(() => {
      mockAccount.isJournalLocked.mockReturnValue(true);
      lockChanged();
    });
    expect(screen.getByRole('heading', { name: 'Journal locked' })).toBeVisible();
    const replacement = { ...firstReading, question: 'Another reading at the original ID' };
    act(() => {
      publish(firstUser.uid, [replacement]);
      mockAccount.isJournalLocked.mockReturnValue(false);
      lockChanged();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { name: replacement.question })).toBeVisible();
    expect(mockJournal.removeReading).not.toHaveBeenCalled();
  });

  it('keeps a confirmed row hidden through stale snapshots and shows a later reimport', async () => {
    const user = userEvent.setup();
    restoreAccountOnMount(firstUser);
    const other = buildReading('other', 'A reading I am keeping');
    const cached = { ...synced, fromCache: true };
    let snapshot!: Parameters<typeof mockJournal.observeReadings>[2];
    mockJournal.observeReadings.mockImplementation((_uid, _count, listener) => {
      snapshot = listener;
      listener([firstReading, other], cached);
      return () => {};
    });
    let acknowledge!: () => void;
    mockJournal.removeReading.mockReturnValueOnce(
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

    const queue = mockJournal.observePendingDeletions.mock.lastCall![1];
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
    restoreAccountOnMount(firstUser);
    const cached = { ...synced, fromCache: true };
    mockJournal.observeReadings.mockImplementation((_uid, _count, listener) => {
      listener([firstReading], cached);
      return () => {};
    });
    mount();
    const row = () => screen.queryByRole('heading', { name: firstReading.question });
    const queue = mockJournal.observePendingDeletions.mock.lastCall![1];
    const previousSnapshot = mockJournal.observeReadings.mock.lastCall![2];
    act(() => queue([{ key: 'replayed', reading: firstReading, durable: true }]));
    expect(row()).toBeNull();
    act(() => queue([]));
    expect(row()).toBeNull();
    act(() => previousSnapshot([firstReading], synced));
    expect(row()).toBeNull();
    const freshSnapshot = mockJournal.observeReadings.mock.lastCall![2];
    await act(async () => freshSnapshot([firstReading], synced));
    expect(row()).toBeVisible();
    expect(mockJournal.removeReading).not.toHaveBeenCalled();
  });

  it('requires a new confirmation when the selected reading is replaced while the dialog is open', async () => {
    const user = userEvent.setup();
    restoreAccountOnMount(firstUser);
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
    expect(mockJournal.removeReading).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole('button', { name: 'Delete reading: ' + replacement.question }),
    );
    expect(screen.getByRole('dialog')).toHaveTextContent(replacement.question);
  });
});
