import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { Reading } from '@/features/Journal/readingTypes';
import {
  firstUser,
  firstReading,
  mount,
  publish,
  restoreAccountOnMount,
} from '@/test/accountJournal';

const replacement: Reading = { ...firstReading, question: 'A different reading with the same ID' };
const fullyRevealed: Reading = {
  ...firstReading,
  createdAt: firstReading.createdAt.replace('Z', '+00:00'),
  cards: firstReading.cards.map((card) => ({ ...card })),
  revealed: [true, true],
};
const sendReading = (reading: Reading) => act(() => publish(firstUser.uid, [reading]));

const revisitReading = async () => {
  const user = userEvent.setup();
  restoreAccountOnMount(firstUser);
  mount('/journal');
  await user.click(screen.getByRole('button', { name: /^Open reading:/ }));
  expect(screen.getByText(firstReading.question)).toBeVisible();
  return user;
};

it('closes the manual copy dialog when another spread takes the open reading’s ID', async () => {
  const user = await revisitReading();
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('Clipboard denied'));
  await user.click(screen.getByRole('button', { name: 'Copy Reading' }));
  const dialog = await screen.findByRole('dialog', { name: 'Copy your reading' });
  await user.click(within(dialog).getByRole('textbox', { name: 'Reading text to copy' }));
  sendReading(fullyRevealed);
  expect(dialog).toBeVisible();
  sendReading(replacement);
  expect(screen.getByText(replacement.question)).toBeVisible();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Copy Reading' })).toHaveFocus();
});

it('keeps a copy confirmation across reveals and clears it for a replacement spread', async () => {
  const user = await revisitReading();
  vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValueOnce(undefined);
  await user.click(screen.getByRole('button', { name: 'Copy Reading' }));
  expect(await screen.findByRole('button', { name: 'Copied Reading' })).toBeVisible();
  sendReading(fullyRevealed);
  expect(screen.getByRole('button', { name: 'Copied Reading' })).toBeVisible();
  sendReading(replacement);
  expect(screen.getByText(replacement.question)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Copy Reading' })).toBeVisible();
});

it('ignores a clipboard rejection for a spread that was replaced before the response', async () => {
  const user = await revisitReading();
  let rejectCopy!: (error: Error) => void;
  vi.spyOn(navigator.clipboard, 'writeText').mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectCopy = reject;
      }),
  );
  await user.click(screen.getByRole('button', { name: 'Copy Reading' }));
  sendReading(replacement);
  expect(screen.getByText(replacement.question)).toBeVisible();
  await act(async () => rejectCopy(new Error('Clipboard denied')));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Copy Reading' })).toBeVisible();
});

it.each([true, false])(
  'dismisses the previous card details when a replacement has the same ID (slot revealed: %s)',
  async (revealed) => {
    const user = await revisitReading();
    await user.click(screen.getByRole('button', { name: /View card details/ }));
    const dialog = screen.getByRole('dialog');
    within(dialog).getByRole('button', { name: 'Close dialog' }).focus();
    sendReading(fullyRevealed);
    expect(dialog).toBeVisible();
    sendReading({
      ...firstReading,
      cards: [firstReading.cards[0], { cardId: 'major-09', orientation: 'upright' }],
      revealed: [false, revealed],
    });
    const cardLabel = revealed ? 'The Hermit, upright. View card details' : 'Reveal card 2';
    expect(screen.getByRole('button', { name: cardLabel })).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: cardLabel })).toHaveFocus();
  },
);

it('keeps details closed after a selected slot is hidden and later revealed in the same spread', async () => {
  const user = await revisitReading();
  await user.click(screen.getByRole('button', { name: /View card details/ }));
  expect(screen.getByRole('dialog')).toBeVisible();
  sendReading({ ...firstReading, revealed: [false, false] });
  expect(screen.getByRole('button', { name: 'Reveal card 2' })).toBeVisible();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  sendReading(firstReading);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /View card details/ }));
  expect(screen.getByRole('dialog')).toBeVisible();
});

it('returns keyboard focus to a surviving card when a replacement removes the selected slot', async () => {
  const user = await revisitReading();
  screen.getByRole('button', { name: /View card details/ }).focus();
  await user.keyboard('{Enter}');
  const dialog = screen.getByRole('dialog');
  within(dialog).getByRole('button', { name: 'Close dialog' }).focus();

  sendReading({ ...firstReading, cards: [firstReading.cards[0]], revealed: [false] });

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Reveal card 1' })).toHaveFocus();
});
