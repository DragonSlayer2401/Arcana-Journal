import {
  renderApp,
  stored,
  useSecureSamples,
  drawButton,
  journalButton,
} from '@/test/guestJournal';
import { TestApp } from '@/test/TestRouter';
import { StrictMode } from 'react';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { cardById } from '@/features/Tarot/data/deck';
import { guestStorageKey } from '@/features/Journal/features/GuestJournal/utils/guestStorage';

describe('drawing and revisiting a reading', () => {
  it('stores the full result once, and preserves it through reveal, details, rerenders, journal and restart', async () => {
    const user = userEvent.setup();
    const random = useSecureSamples();
    const view = renderApp(
      <StrictMode>
        <TestApp />
      </StrictMode>,
    );
    expect(screen.getByRole('button', { name: /Three cards/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('checkbox', { name: /Include reversals/ })).not.toBeChecked();
    await user.type(screen.getByLabelText(/What’s on your mind/), 'What deserves my attention?');
    expect(random).not.toHaveBeenCalled();
    await user.click(drawButton());

    const original = stored().readings[0];
    expect(original.question).toBe('What deserves my attention?');
    expect(original.cards).toHaveLength(3);
    expect(original.cards.every((card) => card.orientation === 'upright')).toBe(true);
    expect(original.revealed).toEqual([false, false, false]);
    expect(random).toHaveBeenCalledTimes(77);
    expect(screen.getAllByRole('button', { name: /^Reveal card/ })).toHaveLength(3);

    await user.click(screen.getByRole('button', { name: 'Reveal card 2' }));
    expect(stored().readings[0].revealed).toEqual([false, true, false]);
    const card = cardById.get(original.cards[1].cardId)!;
    await user.click(
      screen.getByRole('button', { name: `${card.name}, upright. View card details` }),
    );
    expect(screen.getByRole('dialog', { name: card.name })).toHaveTextContent(card.upright.meaning);
    await user.click(screen.getByRole('button', { name: 'Close dialog' }));
    view.rerender(
      <StrictMode>
        <TestApp />
      </StrictMode>,
    );
    await user.click(journalButton());
    await user.click(screen.getByRole('button', { name: /^Open reading:/ }));
    await user.click(screen.getByRole('button', { name: 'Reveal All' }));
    expect(stored().readings[0].revealed).toEqual([true, true, true]);
    expect(stored().readings[0].cards).toEqual(original.cards);

    view.unmount();
    renderApp(
      <StrictMode>
        <TestApp />
      </StrictMode>,
    );
    expect(screen.getAllByRole('button', { name: /View card details/ })).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /Draw Cards/ })).not.toBeInTheDocument();
    expect(stored().readings[0].cards).toEqual(original.cards);
    expect(stored().readings[0].id).toBe(original.id);
    expect(random).toHaveBeenCalledTimes(77);
  });

  it('guards synchronous repeated submissions and double clicks, and allows repeats after New Reading', async () => {
    const user = userEvent.setup();
    const random = useSecureSamples();
    renderApp(<TestApp />);
    const form = drawButton().closest('form')!;
    await act(async () => {
      screen.getByRole('button', { name: /One card/ }).click();
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    const first = stored().readings[0];
    expect(stored().readings).toHaveLength(1);
    expect(first.cards).toHaveLength(1);
    expect(random).toHaveBeenCalledTimes(77);
    expect(screen.queryByRole('button', { name: /Draw Cards/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New Reading' }));
    await user.dblClick(drawButton());
    expect(stored().readings).toHaveLength(2);
    expect(stored().readings[0].cards).toEqual(first.cards);
    expect(stored().readings[0].id).not.toBe(first.id);
    expect(random).toHaveBeenCalledTimes(154);
  });

  it('draws face-up cards immediately and remembers the choice until it is turned off', async () => {
    const user = userEvent.setup();
    const view = renderApp(<TestApp />);
    const instantReveal = () => screen.getByRole('checkbox', { name: /Reveal cards instantly/ });
    expect(instantReveal()).not.toBeChecked();
    await user.click(instantReveal());
    await user.click(drawButton());

    const first = stored().readings[0];
    expect(first.revealed).toEqual([true, true, true]);
    expect(screen.getAllByRole('button', { name: /View card details/ })).toHaveLength(3);
    const card = cardById.get(first.cards[0].cardId)!;
    await user.click(
      screen.getByRole('button', { name: `${card.name}, upright. View card details` }),
    );
    expect(screen.getByRole('dialog', { name: card.name })).toHaveTextContent(card.upright.meaning);

    view.unmount();
    renderApp(<TestApp />);
    await user.click(screen.getByRole('button', { name: 'New Reading' }));
    expect(instantReveal()).toBeChecked();
    await user.click(instantReveal());
    await user.click(drawButton());
    expect(screen.getAllByRole('button', { name: /^Reveal card/ })).toHaveLength(3);
    expect(stored().readings[0].revealed).toEqual([false, false, false]);
    expect(stored().readings[1]).toEqual(first);
  });

  it('draws a custom spread with independent saved reversals and retains settings after restart', async () => {
    const user = userEvent.setup();
    const random = useSecureSamples((index) => (index < 77 ? 0 : (index - 77) % 2));
    const view = renderApp(<TestApp />);
    await user.click(screen.getByRole('button', { name: /Custom/ }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Number of cards' }), '10');
    await user.click(screen.getByRole('checkbox', { name: /Include reversals/ }));
    await user.click(screen.getByRole('button', { name: 'Draw Cards 10' }));
    const original = stored().readings[0];
    expect(original.cards).toHaveLength(10);
    expect(new Set(original.cards.map((card) => card.cardId)).size).toBe(10);
    expect(original.cards.map((card) => card.orientation)).toEqual(
      Array.from({ length: 10 }, (_, index) => (index % 2 ? 'reversed' : 'upright')),
    );
    expect(random).toHaveBeenCalledTimes(87);
    view.unmount();
    renderApp(<TestApp />);
    expect(stored().readings[0].cards).toEqual(original.cards);
    await user.click(screen.getByRole('button', { name: 'New Reading' }));
    expect(screen.getByRole('combobox', { name: 'Number of cards' })).toHaveValue('10');
    expect(screen.getByRole('checkbox', { name: /Include reversals/ })).toBeChecked();
    expect(random).toHaveBeenCalledTimes(87);
  });

  it('supports a one-card reading and does not draw while changing the question or spread', async () => {
    const user = userEvent.setup();
    const random = useSecureSamples();
    renderApp(<TestApp />);
    await user.click(screen.getByRole('button', { name: /One card/ }));
    await user.type(screen.getByLabelText(/What’s on your mind/), 'A different journal note');
    expect(random).not.toHaveBeenCalled();
    await user.click(drawButton());
    expect(stored().readings[0].cards).toHaveLength(1);
    expect(random).toHaveBeenCalledTimes(77);
  });

  it('shows a clear error and creates no reading when secure randomness is unavailable', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('crypto', undefined);
    renderApp(<TestApp />);
    await user.click(drawButton());
    expect(screen.getByRole('alert')).toHaveTextContent('Secure randomness is unavailable');
    expect(screen.getByRole('alert')).toHaveTextContent('No cards were drawn');
    expect(drawButton()).toBeEnabled();
    expect(localStorage.getItem(guestStorageKey)).toBeNull();
  });
});
