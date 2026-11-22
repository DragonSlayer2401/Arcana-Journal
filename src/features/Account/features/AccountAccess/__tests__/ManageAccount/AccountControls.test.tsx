import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mount, mockAccount } from '@/test/accountJournal';
import { TestRouter } from '@/test/TestRouter';
import { AccountPanel } from '@/features/Account/components/AccountPanel';

const person = { uid: 'first', email: 'one@example.org', emailVerified: false };

describe('journal account controls', () => {
  it('offers sign-in and signup from the guest journal account panel', () => {
    mount('/journal');
    const panel = within(screen.getByRole('region', { name: 'Journal account' }));
    expect(panel.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    expect(panel.getByRole('link', { name: 'Create account' })).toHaveAttribute('href', '/signup');
  });

  it('resends and checks verification and signs out after pending writes finish', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<AccountPanel user={person} signOutDisabled />, {
      wrapper: TestRouter,
    });
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Send verification email' }));
    expect(mockAccount.sendVerification).toHaveBeenCalledOnce();
    expect(screen.getByRole('status')).toHaveTextContent('Verification email sent');
    mockAccount.refreshAccount.mockResolvedValueOnce({ ...person, emailVerified: true });
    await user.click(screen.getByRole('button', { name: 'Check verification' }));
    expect(screen.getByRole('status')).toHaveTextContent('Email address verified');
    rerender(<AccountPanel user={{ ...person, emailVerified: true }} />);
    expect(screen.queryByRole('button', { name: 'Check verification' })).not.toBeInTheDocument();
    mockAccount.signOutAccount.mockResolvedValueOnce(undefined);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(mockAccount.signOutAccount).toHaveBeenCalledOnce();
  });
});
