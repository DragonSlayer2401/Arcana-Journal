import { mockAccount, firstUser, mount } from '@/test/accountJournal';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

describe('recovering account access', () => {
  it.each(['auth/invalid-credential', 'auth/user-disabled'])(
    'recovers from rejected credentials (%s) through the password reset page',
    async (code) => {
      const user = userEvent.setup();
      mockAccount.signIn.mockRejectedValueOnce({ code });
      mount('/login');
      await user.type(screen.getByLabelText('Email address'), firstUser.email);
      await user.type(screen.getByLabelText('Password'), 'old-password');
      await user.click(screen.getByRole('button', { name: 'Sign in' }));
      expect(mockAccount.signIn).toHaveBeenCalledWith(firstUser.email, 'old-password', false);
      expect(await screen.findByRole('alert')).toHaveTextContent(/check your email/i);
      await user.click(screen.getByRole('link', { name: 'Forgot password?' }));
      expect(screen.getByRole('heading', { level: 1, name: 'Reset password' })).toBeVisible();
      expect(screen.getByLabelText('Email address')).toHaveValue(firstUser.email);
      if (code === 'auth/user-disabled') mockAccount.resetPassword.mockRejectedValueOnce({ code });
      await user.click(screen.getByRole('button', { name: 'Send reset email' }));
      expect(mockAccount.resetPassword).toHaveBeenCalledWith(firstUser.email);
      expect(await screen.findByRole('status')).toHaveTextContent(firstUser.email);
      await user.click(screen.getByRole('link', { name: 'Back to sign in' }));
      expect(screen.getByLabelText('Password')).toHaveValue('');
    },
  );
});
