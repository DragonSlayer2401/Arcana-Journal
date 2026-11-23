import {
  mockJournal,
  mockPreferences,
  firstUser,
  firstReading,
  mount,
  goToJournal,
  records,
  publish,
  restoreAccountOnMount,
} from '@/test/accountJournal';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { guestStorageKey } from '@/features/Journal/features/GuestJournal/utils/guestStorage';

describe('syncing account readings', () => {
  it('draws into the account, restores a remote reveal in a second session, and deletes across devices', async () => {
    const user = userEvent.setup();
    const guestBefore = localStorage.getItem(guestStorageKey);
    restoreAccountOnMount(firstUser);
    mockJournal.createReading.mockImplementation(async (uid, entry) =>
      publish(uid, [entry, ...records.get(uid)!]),
    );
    mockJournal.revealCards.mockImplementation(async (uid, reading, indexes) => {
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
    mockJournal.removeReading.mockImplementation(async (uid, target) =>
      publish(
        uid,
        records.get(uid)!.filter((entry) => entry.id !== target.id),
      ),
    );
    const app = mount('/');
    await user.type(screen.getByLabelText(/What’s on your mind/), 'A reading across devices');
    await user.click(screen.getByRole('button', { name: /Draw Cards/ }));
    const [uid, drawn] = mockJournal.createReading.mock.calls[0];
    expect(uid).toBe(firstUser.uid);
    expect(drawn.revealed).toEqual([false, false, false]);
    await user.click(screen.getByRole('button', { name: 'Reveal card 1' }));
    expect(mockJournal.revealCards).toHaveBeenCalledWith(uid, drawn, [0]);
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
    expect(mockJournal.createReading).toHaveBeenCalledTimes(1);
    await goToJournal(user);
    await user.click(
      screen.getByRole('button', { name: 'Delete reading: A reading across devices' }),
    );
    const dialog = within(screen.getByRole('dialog', { name: 'Delete this reading?' }));
    expect(dialog.getByText(/every synced device/)).toBeVisible();
    await user.click(dialog.getByRole('button', { name: 'Delete Reading' }));
    expect(mockJournal.removeReading).toHaveBeenCalledWith(uid, remote);
    expect(screen.queryByRole('heading', { name: drawn.question })).toBeNull();
    expect(localStorage.getItem(guestStorageKey)).toBe(guestBefore);
  });

  it('saves an instantly revealed account spread in the initial draw', async () => {
    const user = userEvent.setup();
    restoreAccountOnMount(firstUser);
    mockJournal.createReading.mockImplementation(async (uid, entry) =>
      publish(uid, [entry, ...records.get(uid)!]),
    );
    const app = mount('/');
    await user.click(screen.getByRole('checkbox', { name: /Reveal cards instantly/ }));
    expect(mockPreferences.saveReadingPreference).toHaveBeenCalledWith(
      firstUser.uid,
      'instantReveal',
      true,
    );
    app.unmount();
    sessionStorage.clear();
    mockPreferences.observeReadingPreferences.mockImplementationOnce((_uid, listener) => {
      listener({ reversals: false, instantReveal: true });
      return () => {};
    });
    mount('/');
    expect(screen.getByRole('checkbox', { name: /Reveal cards instantly/ })).toBeChecked();
    await user.click(screen.getByRole('button', { name: /Draw Cards/ }));

    expect(screen.getAllByRole('button', { name: /View card details/ })).toHaveLength(3);
    expect(mockJournal.createReading).toHaveBeenCalledWith(
      firstUser.uid,
      expect.objectContaining({ revealed: [true, true, true] }),
    );
    expect(mockJournal.revealCards).not.toHaveBeenCalled();
  });
});
