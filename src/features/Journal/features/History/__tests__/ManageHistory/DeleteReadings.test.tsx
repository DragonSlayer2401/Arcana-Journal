import {
  renderApp,
  stored,
  useSecureSamples,
  drawButton,
  journalButton,
} from '@/test/guestJournal';
import { TestApp } from '@/test/TestRouter';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';

it('confirms deletion, preserves another active reading, and clears the journal only on confirmation', async () => {
  const user = userEvent.setup();
  const random = useSecureSamples();
  renderApp(<TestApp />);
  await user.type(screen.getByLabelText(/What’s on your mind/), 'First moment');
  await user.click(drawButton());
  await user.click(screen.getByRole('button', { name: 'New Reading' }));
  await user.type(screen.getByLabelText(/What’s on your mind/), 'Second moment');
  await user.click(drawButton());
  const secondId = stored().activeId;
  await user.click(journalButton());
  await user.click(screen.getByRole('button', { name: 'Delete reading: First moment' }));
  await user.click(screen.getByRole('button', { name: 'Keep Reading' }));
  expect(stored().readings).toHaveLength(2);
  await user.click(screen.getByRole('button', { name: 'Delete reading: First moment' }));
  await user.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete Reading' }),
  );
  expect(stored().readings).toHaveLength(1);
  expect(stored().activeId).toBe(secondId);
  await user.click(screen.getByRole('button', { name: 'Clear History' }));
  await user.click(screen.getByRole('button', { name: 'Keep Readings' }));
  expect(stored().readings).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: 'Clear History' }));
  await user.click(screen.getByRole('button', { name: 'Clear All Readings' }));
  expect(stored().readings).toEqual([]);
  expect(stored().activeId).toBeNull();
  expect(screen.getByRole('heading', { name: 'A fresh page awaits.' })).toBeInTheDocument();
  await user.click(screen.getByRole('link', { name: 'Reading' }));
  expect(drawButton()).toBeEnabled();
  expect(random).toHaveBeenCalledTimes(154);
});
