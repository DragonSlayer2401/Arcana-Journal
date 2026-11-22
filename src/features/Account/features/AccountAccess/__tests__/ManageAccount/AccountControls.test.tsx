import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TestRouter } from '@/test/TestRouter';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  refreshAccount,
  sendVerification,
  signOutAccount,
} from '@/services/Account/account.service';
import { AccountPanel } from '@/features/Account/components/AccountPanel';

vi.mock('@/services/Account/account.service', () => ({
  refreshAccount: vi.fn(),
  sendVerification: vi.fn(),
  signOutAccount: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

const person = { uid: 'first', email: 'one@example.org', emailVerified: false };

describe('journal account controls', () => {
  it('links guests directly to the sign-in and signup pages', () => {
    render(<AccountPanel user={null} />, { wrapper: TestRouter });
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    expect(screen.getByRole('link', { name: 'Create account' })).toHaveAttribute('href', '/signup');
  });

  it('resends and checks verification and signs out after pending writes finish', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<AccountPanel user={person} signOutDisabled />, {
      wrapper: TestRouter,
    });
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Send verification email' }));
    expect(sendVerification).toHaveBeenCalledOnce();
    expect(screen.getByRole('status')).toHaveTextContent('Verification email sent');
    vi.mocked(refreshAccount).mockResolvedValueOnce({ ...person, emailVerified: true });
    await user.click(screen.getByRole('button', { name: 'Check verification' }));
    expect(screen.getByRole('status')).toHaveTextContent('Email address verified');
    rerender(<AccountPanel user={{ ...person, emailVerified: true }} />);
    expect(screen.queryByRole('button', { name: 'Check verification' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOutAccount).toHaveBeenCalledOnce();
  });
});
