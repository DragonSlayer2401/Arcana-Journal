import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { resetLockedJournalPassword, unlockJournal } from '@/services/Account/account.service';
import { LockedJournal } from '@/features/Account/components/LockedJournal';

vi.mock('@/services/Account/account.service', () => ({
  resetLockedJournalPassword: vi.fn(),
  unlockJournal: vi.fn(),
}));

it('recovers the locked owner’s password and still requires an explicit unlock', async () => {
  const user = userEvent.setup();
  vi.mocked(resetLockedJournalPassword)
    .mockRejectedValueOnce({ code: 'auth/network-request-failed' })
    .mockResolvedValueOnce(undefined);
  render(<LockedJournal uid="original-owner" hasFailedWrites={false} saving={false} />);
  const reset = screen.getByRole('button', { name: 'Send password reset email' });

  await user.click(reset);
  expect(await screen.findByRole('alert')).toHaveTextContent(/connect to the internet/i);
  await user.click(reset);
  expect(await screen.findByRole('status')).toHaveTextContent(/check your account inbox/i);
  expect(resetLockedJournalPassword).toHaveBeenLastCalledWith('original-owner');
  expect(screen.queryByLabelText(/email address/i)).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Journal locked' })).toBeVisible();
  expect(unlockJournal).not.toHaveBeenCalled();

  await user.type(screen.getByLabelText('Password'), 'new owner password');
  await user.click(screen.getByRole('button', { name: 'Unlock journal' }));
  expect(unlockJournal).toHaveBeenCalledWith('original-owner', 'new owner password');
});
