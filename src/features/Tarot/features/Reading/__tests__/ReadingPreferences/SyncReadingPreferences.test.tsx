import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import {
  firstUser,
  mockJournal,
  mockPreferences,
  mount,
  nextUser,
  publish,
  restoreAccountOnMount,
  setAccount,
} from '@/test/accountJournal';
import {
  guestStorageKey,
  loadData,
} from '@/features/Journal/features/GuestJournal/utils/guestStorage';

const reversals = () => screen.getByRole('checkbox', { name: /Include reversals/ });
const instantReveal = () => screen.getByRole('checkbox', { name: /Reveal cards instantly/ });
const retryPreferenceSync = () => screen.getByRole('button', { name: 'Retry preference sync' });

it('restores guest choices on an immediate reload, including a change from a legacy journal setting', () => {
  const journal = loadData().data;
  const saved = JSON.stringify({ ...journal, settings: { ...journal.settings, reversals: true } });
  localStorage.setItem(guestStorageKey, saved);
  const view = mount('/');
  expect(reversals()).toBeChecked();
  fireEvent.click(instantReveal());
  fireEvent.click(reversals());
  view.unmount();
  mount('/');
  expect(instantReveal()).toBeChecked();
  expect(reversals()).not.toBeChecked();
  expect(localStorage.getItem(guestStorageKey)).toBe(saved);
});

it('uses the guest’s chosen settings for the current draw when preference storage is blocked', async () => {
  const user = userEvent.setup();
  mount('/');
  vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
    throw new DOMException('Storage full', 'QuotaExceededError');
  });
  await user.click(instantReveal());
  expect(screen.getByRole('alert')).toHaveTextContent(/could not save your reading preferences/i);
  await user.click(screen.getByRole('button', { name: /Draw Cards/ }));
  expect(screen.getAllByRole('button', { name: /View card details/ })).toHaveLength(3);
  expect(loadData().data.readings[0].revealed).toEqual([true, true, true]);
});

it('picks up a guest setting changed in another tab while the account is awaiting verification', () => {
  const storageWrites = vi.spyOn(Storage.prototype, 'setItem');
  mount('/');
  fireEvent.click(instantReveal());
  const [key] = storageWrites.mock.lastCall!;
  act(() => setAccount({ ...firstUser, emailVerified: false }));
  act(() => {
    localStorage.setItem(key, 'false');
    window.dispatchEvent(new StorageEvent('storage', { key, storageArea: localStorage }));
  });
  act(() => setAccount(null));
  expect(instantReveal()).not.toBeChecked();
  fireEvent.click(reversals());
  act(() => {
    localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: localStorage }));
  });
  expect(reversals()).not.toBeChecked();
});

it('waits for the profile before allowing a draw with account preferences', async () => {
  const user = userEvent.setup();
  restoreAccountOnMount(firstUser);
  mockPreferences.observeReadingPreferences.mockImplementationOnce(() => () => {});
  mount('/');
  const drawButton = screen.getByRole('button', { name: /Draw Cards/ });
  expect(reversals()).toBeDisabled();
  expect(instantReveal()).toBeDisabled();
  expect(drawButton).toBeDisabled();
  await user.click(drawButton);
  expect(mockJournal.createReading).not.toHaveBeenCalled();

  const [, receivePreferences] = mockPreferences.observeReadingPreferences.mock.lastCall!;
  act(() => receivePreferences({ reversals: false, instantReveal: true }));
  expect(instantReveal()).toBeChecked();
  expect(drawButton).toBeEnabled();
  expect(mockPreferences.saveReadingPreference).not.toHaveBeenCalled();
});

it('reconnects a failed profile listener and retries an edit made while access was denied', async () => {
  const user = userEvent.setup();
  restoreAccountOnMount(firstUser);
  mockPreferences.observeReadingPreferences.mockImplementationOnce(() => () => {});
  const denied = Object.assign(new Error('Permission denied'), { code: 'permission-denied' });
  mockPreferences.saveReadingPreference.mockRejectedValueOnce(denied);
  mount('/');
  const [, , failToLoad] = mockPreferences.observeReadingPreferences.mock.lastCall!;
  act(() => failToLoad(denied));
  expect(screen.getByRole('button', { name: /Draw Cards/ })).toBeEnabled();
  expect(screen.getByRole('alert')).toHaveTextContent(/access/i);
  await user.click(instantReveal());
  expect(mockPreferences.saveReadingPreference).toHaveBeenCalledWith(
    firstUser.uid,
    'instantReveal',
    true,
  );
  expect(instantReveal()).toBeChecked();
  expect(screen.getByRole('alert')).toHaveTextContent(/denied permission|access denied/i);
  expect(loadData().data.settings.instantReveal).toBe(false);
  mockPreferences.saveReadingPreference.mockClear();
  await user.click(retryPreferenceSync());
  expect(mockPreferences.observeReadingPreferences).toHaveBeenCalledTimes(2);
  expect(mockPreferences.saveReadingPreference.mock.calls).toEqual([
    [firstUser.uid, 'instantReveal', true],
  ]);
  const [, reconnected] = mockPreferences.observeReadingPreferences.mock.lastCall!;
  act(() => reconnected({ reversals: true, instantReveal: false }));
  expect(reversals()).toBeChecked();
  expect(instantReveal()).not.toBeChecked();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('draws with both unsynced choices after a rollback and retries only the latest failed edits', async () => {
  const user = userEvent.setup();
  restoreAccountOnMount(firstUser);
  const rejected = new Error('Write rejected');
  mockPreferences.saveReadingPreference.mockRejectedValue(rejected);
  mockJournal.createReading.mockImplementation(async (uid, reading) => publish(uid, [reading]));
  vi.spyOn(crypto, 'getRandomValues').mockImplementation((target) => {
    (target as Uint32Array)[0] = 1;
    return target;
  });
  mount('/');
  const [, receivePreferences] = mockPreferences.observeReadingPreferences.mock.lastCall!;
  await user.click(instantReveal());
  await user.click(reversals());
  act(() => receivePreferences({ reversals: false, instantReveal: false }));
  expect(instantReveal()).toBeChecked();
  expect(reversals()).toBeChecked();
  expect(screen.getByRole('alert')).toHaveTextContent(/tab/i);
  await user.click(screen.getByRole('button', { name: /Draw Cards/ }));
  expect(screen.getAllByRole('button', { name: /reversed\. View card details/i })).toHaveLength(3);

  await user.click(screen.getByRole('button', { name: 'New Reading' }));
  act(() => receivePreferences({ reversals: true, instantReveal: false }));
  await user.click(reversals());
  mockPreferences.saveReadingPreference.mockClear();
  mockPreferences.saveReadingPreference.mockImplementation(async (_uid, key) => {
    if (key === 'instantReveal') throw rejected;
  });
  await user.click(retryPreferenceSync());
  expect(mockPreferences.saveReadingPreference.mock.calls).toHaveLength(2);
  expect(mockPreferences.saveReadingPreference.mock.calls).toEqual(
    expect.arrayContaining([
      [firstUser.uid, 'reversals', false],
      [firstUser.uid, 'instantReveal', true],
    ]),
  );
  act(() => receivePreferences({ reversals: false, instantReveal: false }));
  expect(reversals()).not.toBeChecked();
  expect(instantReveal()).toBeChecked();

  mockPreferences.saveReadingPreference.mockClear();
  mockPreferences.saveReadingPreference.mockResolvedValue(undefined);
  await user.click(retryPreferenceSync());
  expect(mockPreferences.saveReadingPreference.mock.calls).toEqual([
    [firstUser.uid, 'instantReveal', true],
  ]);
  act(() => receivePreferences({ reversals: false, instantReveal: true }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  act(() => receivePreferences({ reversals: true, instantReveal: false }));
  expect(reversals()).toBeChecked();
  expect(instantReveal()).not.toBeChecked();
});

it('applies changes from another device without resetting the current spread or question', async () => {
  const user = userEvent.setup();
  restoreAccountOnMount(firstUser);
  mount('/');
  await user.click(screen.getByRole('button', { name: /Custom/ }));
  await user.selectOptions(screen.getByRole('combobox', { name: 'Number of cards' }), '2');
  await user.type(screen.getByLabelText(/What’s on your mind/), 'A question in progress');
  const [, receivePreferences] = mockPreferences.observeReadingPreferences.mock.lastCall!;
  act(() => receivePreferences({ reversals: true, instantReveal: true }));
  expect(reversals()).toBeChecked();
  expect(instantReveal()).toBeChecked();
  expect(screen.getByRole('combobox', { name: 'Number of cards' })).toHaveValue('2');
  expect(screen.getByLabelText(/What’s on your mind/)).toHaveValue('A question in progress');
  expect(mockPreferences.saveReadingPreference).not.toHaveBeenCalled();

  mockPreferences.saveReadingPreference.mockRejectedValueOnce(new Error('Write rejected'));
  await user.click(reversals());
  expect(mockPreferences.saveReadingPreference).toHaveBeenCalledWith(
    firstUser.uid,
    'reversals',
    false,
  );
  expect(instantReveal()).toBeChecked();
  expect(retryPreferenceSync()).toBeEnabled();
  act(() => setAccount(nextUser));
  act(() => receivePreferences({ reversals: true, instantReveal: true }));
  expect(screen.queryByRole('button', { name: 'Retry preference sync' })).not.toBeInTheDocument();
  expect(reversals()).not.toBeChecked();
  expect(instantReveal()).not.toBeChecked();
  await user.click(instantReveal());
  expect(mockPreferences.saveReadingPreference).toHaveBeenLastCalledWith(
    nextUser.uid,
    'instantReveal',
    true,
  );
});

it('keeps the latest toggle when another device changes the other setting during a save', async () => {
  const user = userEvent.setup();
  let rejectFirstSave!: (error: Error) => void;
  mockPreferences.saveReadingPreference.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectFirstSave = reject;
      }),
  );
  restoreAccountOnMount(firstUser);
  mount('/');
  await user.click(reversals());
  const [, receivePreferences] = mockPreferences.observeReadingPreferences.mock.lastCall!;
  act(() => receivePreferences({ reversals: false, instantReveal: true }));
  expect(reversals()).toBeChecked();
  expect(instantReveal()).toBeChecked();

  await user.click(reversals());
  await act(async () => rejectFirstSave(new Error('Earlier write rejected')));
  expect(reversals()).not.toBeChecked();
  expect(instantReveal()).toBeChecked();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('uses account preferences before verification while saving the draw in the device journal', async () => {
  const user = userEvent.setup();
  const question = 'What should I focus on today?';
  mount('/');
  await user.type(screen.getByLabelText(/What’s on your mind/), question);
  await user.click(reversals());
  expect(reversals()).toBeChecked();
  expect(mockPreferences.saveReadingPreference).not.toHaveBeenCalled();
  expect(mockPreferences.observeReadingPreferences).not.toHaveBeenCalled();

  act(() => setAccount({ ...firstUser, emailVerified: false }));
  expect(screen.getByLabelText(/What’s on your mind/)).toHaveValue(question);
  expect(reversals()).not.toBeChecked();
  await user.click(instantReveal());
  expect(mockPreferences.saveReadingPreference).toHaveBeenCalledWith(
    firstUser.uid,
    'instantReveal',
    true,
  );
  await user.click(screen.getByRole('button', { name: /Draw Cards/ }));
  expect(screen.getAllByRole('button', { name: /View card details/ })).toHaveLength(3);
  expect(mockJournal.createReading).not.toHaveBeenCalled();
  const deviceJournal = loadData().data;
  expect(deviceJournal.readings[0].question).toBe(question);
  expect(deviceJournal.readings[0].revealed).toEqual([true, true, true]);

  act(() => setAccount(null));
  await user.click(screen.getByRole('button', { name: 'New Reading' }));
  expect(reversals()).toBeChecked();
  expect(instantReveal()).not.toBeChecked();
});
