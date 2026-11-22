import {
  mockAccount,
  mockJournal,
  firstUser,
  deviceReading,
  mount,
  setAccount,
} from '@/test/accountJournal';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

describe('creating an account', () => {
  it('opens signup from the main sign-in link and creates a trusted account after confirming the password', async () => {
    const user = userEvent.setup();
    mockAccount.signUp.mockImplementation(async () =>
      setAccount({ ...firstUser, emailVerified: false }),
    );
    mount('/');
    const signInLink = within(screen.getByRole('banner')).getByRole('link', { name: 'Sign in' });
    await user.click(signInLink);
    const signIn = within(await screen.findByRole('dialog', { name: 'Sign in' }));
    await user.click(signIn.getByRole('link', { name: 'Create account' }));
    expect(await screen.findByRole('dialog', { name: 'Create account' })).toBeVisible();
    await user.type(screen.getByLabelText('Email address'), firstUser.email);
    await user.type(screen.getByLabelText('Password', { exact: true }), 'test-password');
    const confirmation = screen.getByLabelText('Confirm password');
    await user.type(confirmation, 'wrong-password');
    const submit = screen.getByRole('button', { name: 'Create account' });
    await user.click(submit);
    expect(screen.getByRole('alert')).toHaveTextContent(/match/i);
    expect(mockAccount.signUp).not.toHaveBeenCalled();
    await user.clear(confirmation);
    await user.type(confirmation, 'test-password');
    const trust = screen.getByRole('checkbox');
    expect(trust).not.toBeChecked();
    await user.click(trust);
    await user.click(submit);
    expect(mockAccount.signUp).toHaveBeenCalledWith(firstUser.email, 'test-password', true);
    expect(await screen.findByRole('heading', { name: 'Your reading journal.' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Check verification' })).toBeVisible();
    expect(screen.getByRole('heading', { name: deviceReading.question })).toBeVisible();
    expect(mockJournal.observeReadings).not.toHaveBeenCalled();
  });

  it('offers recovery after a rejected signup without confirming who has registered', async () => {
    const user = userEvent.setup();
    mockAccount.signUp.mockRejectedValueOnce({ code: 'auth/email-already-in-use' });
    mount('/signup');
    await user.type(screen.getByLabelText('Email address'), firstUser.email);
    await user.type(screen.getByLabelText('Password', { exact: true }), 'test-password');
    await user.type(screen.getByLabelText('Confirm password'), 'test-password');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We couldn’t create an account with those details. Try signing in or resetting your password.',
    );
    expect(mockJournal.observeReadings).not.toHaveBeenCalled();
  });
});
