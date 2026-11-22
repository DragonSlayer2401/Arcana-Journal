import { renderApp, stored, useSecureSamples, drawButton } from '@/test/guestJournal';
import { TestApp } from '@/test/TestRouter';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { cardById } from '@/features/Tarot/data/deck';

it('copies the complete spread in order, with a selectable fallback when clipboard access fails', async () => {
  const user = userEvent.setup();
  const random = useSecureSamples();
  const clipboard = vi
    .spyOn(navigator.clipboard, 'writeText')
    .mockRejectedValueOnce(new Error('Clipboard denied'));
  renderApp(<TestApp />);
  await user.type(screen.getByLabelText(/What’s on your mind/), 'Where can I begin?');
  await user.click(drawButton());
  const original = stored().readings[0];
  await user.click(screen.getByRole('button', { name: 'Copy Reading' }));
  const fallback = await screen.findByRole('textbox', { name: 'Reading text to copy' });
  const text = (fallback as HTMLTextAreaElement).value;
  expect(text).toContain('Question: Where can I begin?');
  original.cards.forEach((card, index) =>
    expect(text).toContain(`${index + 1}. ${cardById.get(card.cardId)!.name} — Upright`),
  );
  expect(fallback).toHaveAttribute('readonly');
  await user.click(screen.getByRole('button', { name: 'Close dialog' }));
  clipboard.mockResolvedValueOnce(undefined);
  await user.click(screen.getByRole('button', { name: 'Copy Reading' }));
  expect(await screen.findByRole('button', { name: 'Copied Reading' })).toBeInTheDocument();
  expect(clipboard).toHaveBeenLastCalledWith(text);
  expect(stored().readings[0].cards).toEqual(original.cards);
  expect(random).toHaveBeenCalledTimes(77);
});

it('keeps the successful copy confirmation when an earlier clipboard request fails later', async () => {
  const user = userEvent.setup();
  let rejectFirstCopy!: (error: Error) => void;
  const firstCopy = new Promise<void>((_resolve, reject) => {
    rejectFirstCopy = reject;
  });
  vi.spyOn(navigator.clipboard, 'writeText')
    .mockReturnValueOnce(firstCopy)
    .mockResolvedValueOnce(undefined);
  renderApp(<TestApp />);
  await user.click(drawButton());
  const copy = screen.getByRole('button', { name: 'Copy Reading' });
  await user.click(copy);
  await user.click(copy);
  expect(await screen.findByRole('button', { name: 'Copied Reading' })).toBeVisible();

  await act(async () => rejectFirstCopy(new Error('Clipboard denied')));
  expect(screen.getByRole('button', { name: 'Copied Reading' })).toBeVisible();
  expect(screen.queryByRole('dialog', { name: 'Copy your reading' })).not.toBeInTheDocument();
});
