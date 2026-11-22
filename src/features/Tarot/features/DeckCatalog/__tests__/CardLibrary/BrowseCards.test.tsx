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
import { describe, expect, it } from 'vitest';
import { cardById, tarotDeck } from '@/features/Tarot/data/deck';

const cardNamePattern = new RegExp(`^(?:${tarotDeck.map((card) => card.name).join('|')})$`);

describe('exploring the card library', () => {
  it('browses all 78 cards, combines search and suit filters, and shows both meanings without drawing', async () => {
    const user = userEvent.setup();
    const random = useSecureSamples();
    renderApp(<TestApp />);
    await user.click(screen.getByRole('link', { name: 'Deck' }));
    expect(screen.getByRole('heading', { name: 'Card library', level: 1 })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: cardNamePattern })).toHaveLength(78);

    const search = screen.getByLabelText('Search cards');
    const filter = screen.getByRole('combobox', { name: 'Arcana or suit' });
    await user.type(search, 'queen');
    expect(screen.getAllByRole('button', { name: cardNamePattern })).toHaveLength(4);
    await user.selectOptions(filter, within(filter).getByRole('option', { name: 'Cups' }));
    expect(screen.getAllByRole('button', { name: cardNamePattern })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Queen of Cups' }));
    const queen = cardById.get('minor-cups-13')!;
    const dialog = screen.getByRole('dialog', { name: queen.name });
    expect(within(dialog).getByText('Upright', { exact: true })).toBeVisible();
    expect(within(dialog).getByText('Reversed', { exact: true })).toBeVisible();
    expect(dialog).toHaveTextContent(queen.upright.meaning);
    expect(dialog).toHaveTextContent(queen.reversed.meaning);
    await user.click(within(dialog).getByRole('button', { name: 'Close dialog' }));

    await user.clear(search);
    expect(screen.getAllByRole('button', { name: cardNamePattern })).toHaveLength(14);
    await user.selectOptions(filter, within(filter).getByRole('option', { name: 'Major Arcana' }));
    expect(screen.getAllByRole('button', { name: cardNamePattern })).toHaveLength(22);
    await user.type(search, 'no matching tarot card');
    expect(screen.queryAllByRole('button', { name: cardNamePattern })).toHaveLength(0);
    await user.click(screen.getByRole('link', { name: 'Show all cards' }));
    expect(screen.getAllByRole('button', { name: cardNamePattern })).toHaveLength(78);
    expect(random).not.toHaveBeenCalled();
    await user.click(screen.getByRole('link', { name: 'Reading' }));
    expect(drawButton()).toBeEnabled();
  });

  it('preserves a partially revealed saved reading while visiting the library and card details', async () => {
    const user = userEvent.setup();
    const random = useSecureSamples();
    renderApp(<TestApp />);
    await user.type(screen.getByLabelText(/What’s on your mind/), 'A reading to return to');
    await user.click(drawButton());
    await user.click(screen.getByRole('button', { name: 'Reveal card 2' }));
    const original = stored();
    expect(random).toHaveBeenCalledTimes(77);

    await user.click(screen.getByRole('link', { name: 'Deck' }));
    await user.type(screen.getByLabelText('Search cards'), 'The Hermit');
    await user.click(screen.getByRole('button', { name: 'The Hermit' }));
    const hermit = cardById.get('major-09')!;
    const dialog = screen.getByRole('dialog', { name: hermit.name });
    expect(dialog).toHaveTextContent(hermit.upright.meaning);
    expect(dialog).toHaveTextContent(hermit.reversed.meaning);
    await user.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
    expect(stored()).toEqual(original);
    await user.click(screen.getByRole('link', { name: 'Reading' }));
    expect(drawButton()).toBeEnabled();
    await user.click(journalButton());
    await user.click(screen.getByRole('button', { name: /^Open reading:/ }));
    expect(screen.getAllByRole('button', { name: /^Reveal card/ })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /View card details/ })).toHaveLength(1);
    expect(stored()).toEqual(original);
    expect(random).toHaveBeenCalledTimes(77);
  });
});
