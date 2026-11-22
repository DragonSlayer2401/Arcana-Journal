import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import {
  firstUser,
  goToJournal,
  mockJournal,
  mount,
  publish,
  restoreAccountOnMount,
} from '@/test/accountJournal';
import { captureBackup } from '@/test/captureBackup';

afterEach(() => vi.unstubAllGlobals());

const drawRejectedReading = async (user: ReturnType<typeof userEvent.setup>) => {
  restoreAccountOnMount(firstUser);
  mockJournal.createReading.mockRejectedValueOnce(new Error('Write denied'));
  mount('/');
  await user.type(screen.getByLabelText(/What’s on your mind/), 'A question only this device has');
  await user.click(screen.getByRole('button', { name: /Draw Cards/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Write denied');
  return mockJournal.createReading.mock.calls[0][1];
};

it('downloads a rejected draw offline with its latest reveals and can discard it before signing out', async () => {
  const user = userEvent.setup();
  const download = captureBackup();
  const draw = await drawRejectedReading(user);
  await user.click(screen.getByRole('button', { name: 'Reveal card 2' }));
  expect(mockJournal.revealCards).not.toHaveBeenCalled();
  await goToJournal(user);
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeDisabled();

  await user.click(screen.getByRole('button', { name: 'Download unsynced readings' }));
  expect(await screen.findByRole('link', { name: 'Download backup' })).toHaveAttribute(
    'download',
    expect.stringContaining('unsynced'),
  );
  expect(await download()).toEqual({
    version: 1,
    readings: [{ ...draw, revealed: [false, true, false] }],
  });
  expect(mockJournal.exportAccountJournal).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'Delete reading: ' + draw.question }));
  const dialog = within(screen.getByRole('dialog', { name: 'Delete this reading?' }));
  expect(dialog.getByText(/discarded from this tab/)).toBeVisible();
  await user.click(dialog.getByRole('button', { name: 'Delete Reading' }));
  expect(mockJournal.removeReading).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled();
  expect(screen.queryByRole('heading', { name: draw.question })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Download unsynced readings' })).toBeNull();
});

it('retries a failed draw with the original spread and all local reveal progress', async () => {
  const user = userEvent.setup();
  const draw = await drawRejectedReading(user);
  await user.click(screen.getByRole('button', { name: 'Reveal card 1' }));
  await user.click(screen.getByRole('button', { name: 'Reveal card 2' }));
  await goToJournal(user);
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeDisabled();
  mockJournal.createReading.mockImplementationOnce(async (uid, reading) => publish(uid, [reading]));
  await user.click(screen.getByRole('button', { name: 'Retry sync' }));
  expect(mockJournal.createReading).toHaveBeenLastCalledWith(firstUser.uid, {
    ...draw,
    revealed: [true, true, false],
  });
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Download unsynced readings' })).toBeNull();
  await user.click(
    screen.getByRole('button', { name: /Open reading: A question only this device has/ }),
  );
  expect(screen.getAllByRole('button', { name: /View card details/ })).toHaveLength(2);
  expect(screen.getByRole('button', { name: 'Reveal card 3' })).toBeVisible();
});
