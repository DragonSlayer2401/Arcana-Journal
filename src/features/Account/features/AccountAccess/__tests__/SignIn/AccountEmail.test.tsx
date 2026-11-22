import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { mount } from '@/test/accountJournal';

it('keeps the email across account forms and clears it when the user leaves account access', async () => {
  const user = userEvent.setup();
  mount('/login');
  const emailField = () => screen.getByLabelText('Email address');
  const main = within(screen.getByRole('main'));
  const email = 'reader@example.test';
  await user.type(emailField(), email);
  await user.click(main.getByRole('link', { name: 'Create account' }));
  expect(emailField()).toHaveValue(email);
  await user.click(main.getByRole('link', { name: 'Sign in' }));
  await user.click(main.getByRole('link', { name: 'Forgot password?' }));
  expect(emailField()).toHaveValue(email);
  await user.click(screen.getByRole('link', { name: 'Deck' }));
  expect(screen.getByRole('heading', { name: 'Card library' })).toBeVisible();
  await user.click(screen.getByRole('link', { name: 'Sign in' }));
  expect(emailField()).toHaveValue('');
});
