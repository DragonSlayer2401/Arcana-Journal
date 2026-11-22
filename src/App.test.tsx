import { StrictMode, type ReactNode } from 'react';
import { TestApp, TestRouter } from './test/TestRouter';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CARD_BY_ID, DECK } from './data/deck';
import { STORAGE_KEY, RECOVERY_KEY, type AppData } from './domain/storage';
import { captureBackup } from './test/captureBackup';
import { webcrypto } from 'node:crypto';

vi.mock('./pwa', () => ({ subscribeOfflineStatus: () => () => {} }));
vi.mock('./cloud/journal', () => ({
  observeAccount: (change: (user: null) => void) => {
    change(null);
    return () => {};
  },
}));

beforeAll(() => {
  // jsdom has no native modal presentation. Keep its open/closed semantics.
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const renderApp = (ui: ReactNode, path = '/') =>
  render(ui, {
    wrapper: ({ children }) => <TestRouter path={path}>{children}</TestRouter>,
  });

const stored = (): AppData => JSON.parse(localStorage.getItem(STORAGE_KEY)!);
const useSecureSamples = (sample: (index: number) => number = () => 0) => {
  let index = 0;
  return vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((target) => {
    (target as Uint32Array)[0] = sample(index++);
    return target;
  });
};
const drawButton = () => screen.getByRole('button', { name: /Draw Cards/ });
const journalButton = () => screen.getByRole('link', { name: /^Journal/ });
const cardNamePattern = new RegExp(`^(?:${DECK.map((card) => card.name).join('|')})$`);

describe('routed navigation', () => {
  it.each([
    ['/deck', 'Card library', 'Deck'],
    ['/journal', 'Your reading journal.', 'Journal'],
  ])('opens %s directly without creating a reading', (path, heading, navigation) => {
    const random = useSecureSamples();
    renderApp(<TestApp />, path);
    expect(screen.getByRole('heading', { name: heading, level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: navigation })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Reading' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Deck' })).toHaveAttribute('href', '/deck');
    expect(screen.getByRole('link', { name: /^Journal/ })).toHaveAttribute('href', '/journal');
    expect(random).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('returns from an empty journal through the Go to Reading link without drawing', async () => {
    const user = userEvent.setup();
    const random = useSecureSamples();
    renderApp(<TestApp />, '/journal');
    const returnLink = screen.getByRole('link', { name: 'Go to Reading' });
    expect(returnLink).toHaveAttribute('href', '/');
    await user.click(returnLink);
    expect(drawButton()).toBeEnabled();
    expect(screen.getByRole('link', { name: 'Reading' })).toHaveAttribute('aria-current', 'page');
    expect(random).not.toHaveBeenCalled();
  });

  it('keeps a draft question when returning to the drawing form', async () => {
    const user = userEvent.setup();
    renderApp(<TestApp />);
    await user.type(screen.getByLabelText(/What’s on your mind/), 'An unfinished question');
    await user.click(screen.getByRole('link', { name: 'Deck' }));
    await user.click(screen.getByRole('link', { name: 'Reading' }));
    await user.click(screen.getByRole('link', { name: 'Arcana Journal, reading' }));
    expect(screen.getByLabelText(/What’s on your mind/)).toHaveValue('An unfinished question');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('keeps the current spread open on a modified Reading link click', async () => {
    const user = userEvent.setup();
    renderApp(<TestApp />);
    await user.click(drawButton());
    const original = stored();
    await user.keyboard('{Control>}');
    await user.click(screen.getByRole('link', { name: 'Reading' }));
    await user.keyboard('{/Control}');
    expect(screen.getByRole('button', { name: 'Reveal card 1' })).toBeVisible();
    expect(stored()).toEqual(original);
  });
});

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
    const queen = CARD_BY_ID.get('minor-cups-13')!;
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
    const hermit = CARD_BY_ID.get('major-09')!;
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
    const card = CARD_BY_ID.get(original.cards[1].cardId)!;
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
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    const first = stored().readings[0];
    expect(stored().readings).toHaveLength(1);
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
    const card = CARD_BY_ID.get(first.cards[0].cardId)!;
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
    await user.click(drawButton());
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
});

describe('reading recovery and journal controls', () => {
  it('shows a clear error and creates no reading when secure randomness is unavailable', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('crypto', undefined);
    renderApp(<TestApp />);
    await user.click(drawButton());
    expect(screen.getByRole('alert')).toHaveTextContent('Secure randomness is unavailable');
    expect(screen.getByRole('alert')).toHaveTextContent('No cards were drawn');
    expect(drawButton()).toBeEnabled();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('can revisit and export the session reading when storage rejects writes', async () => {
    const user = userEvent.setup();
    const random = useSecureSamples();
    const failedWrite = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    const backup = captureBackup();
    renderApp(<TestApp />);
    await user.click(drawButton());
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Your cards are still available in this session',
    );
    expect(screen.getAllByRole('button', { name: /^Reveal card/ })).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: 'Reveal All' }));
    const names = screen
      .getAllByRole('button', { name: /View card details/ })
      .map((button) => button.getAttribute('aria-label'));
    const session: AppData = JSON.parse(failedWrite.mock.lastCall![1]);
    await user.click(journalButton());
    await user.click(screen.getByRole('button', { name: 'Export journal' }));
    expect(await screen.findByRole('link', { name: 'Download backup' })).toHaveAttribute(
      'download',
    );
    expect(session.readings).toHaveLength(1);
    expect(await backup()).toEqual({ version: 1, readings: session.readings });
    await user.click(screen.getByRole('button', { name: /^Open reading:/ }));
    expect(
      screen
        .getAllByRole('button', { name: /View card details/ })
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(names);
    expect(random).toHaveBeenCalledTimes(77);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('preserves a sibling draw when the next guest storage read fails once', async () => {
    const user = userEvent.setup();
    const backup = captureBackup();
    const first = within(renderApp(<TestApp />).container);
    const sibling = within(renderApp(<TestApp />).container);
    await user.type(sibling.getByRole('textbox'), 'Sibling draw');
    await user.click(sibling.getByRole('button', { name: /Draw Cards/ }));
    const saved = stored();
    await user.type(first.getByRole('textbox'), 'First tab draw');
    const get = Storage.prototype.getItem;
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (
      this: Storage,
      key: string,
    ) {
      if (key === STORAGE_KEY) {
        read.mockRestore();
        throw new DOMException('Storage unavailable', 'SecurityError');
      }
      return get.call(this, key);
    });
    await user.click(first.getByRole('button', { name: /Draw Cards/ }));
    expect(first.getByRole('alert')).toHaveTextContent('still available in this session');
    expect(stored()).toEqual(saved);
    await user.click(first.getByRole('link', { name: /^Journal/ }));
    await user.click(first.getByRole('button', { name: 'Export journal' }));
    await first.findByRole('link', { name: 'Download backup' });
    const file = await backup();
    expect(file.readings).toHaveLength(2);
    expect(file.readings).toContainEqual(saved.readings[0]);
    expect(file.readings.some((reading) => reading.question === 'First tab draw')).toBe(true);
  });

  it('keeps the open spread usable after another guest tab starts a new reading', async () => {
    const user = userEvent.setup();
    const first = within(renderApp(<TestApp />).container);
    await user.click(first.getByRole('button', { name: /Draw Cards/ }));
    const original = stored().readings[0];
    const second = within(renderApp(<TestApp />).container);
    await user.click(second.getByRole('button', { name: 'New Reading' }));
    await user.click(first.getByRole('button', { name: 'Reveal card 1' }));
    expect(first.getAllByRole('button', { name: /View card details/ })).toHaveLength(1);
    expect(second.getByRole('button', { name: /Draw Cards/ })).toBeEnabled();
    expect(stored().readings[0]).toEqual({ ...original, revealed: [true, false, false] });
    await user.click(first.getByRole('button', { name: 'New Reading' }));
    await user.click(first.getByRole('button', { name: /Draw Cards/ }));
    expect(stored().readings).toHaveLength(2);
  });

  it('restores a guest reveal alongside a separately imported copy without restoring a sibling deletion', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('crypto', webcrypto);
    const backup = captureBackup();
    const view = renderApp(<TestApp />);
    await user.type(screen.getByLabelText(/What’s on your mind/), 'Delete in the other tab');
    await user.click(drawButton());
    await user.click(screen.getByRole('button', { name: 'New Reading' }));
    await user.click(drawButton());
    const original = stored();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    await user.click(screen.getByRole('button', { name: 'Reveal card 2' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Your cards are still available');
    const sibling = { ...original.readings[0], id: 'import-' + 'a'.repeat(64) };
    const persisted = { ...original, readings: [sibling], activeId: sibling.id };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
    await user.click(journalButton());
    await user.click(screen.getByRole('button', { name: 'Export journal' }));
    expect(await screen.findByRole('link', { name: 'Download backup' })).toBeVisible();
    const file = await backup();
    const edited = { ...original.readings[0], revealed: [false, true, false] };
    expect(file.readings).toHaveLength(2);
    expect(file.readings).toEqual(expect.arrayContaining([sibling, edited]));
    expect(stored()).toEqual(persisted);
    view.unmount();
    renderApp(<TestApp />, '/journal');
    await user.upload(
      screen.getByLabelText('Journal backup file'),
      new File([JSON.stringify(file)], 'guest.json', { type: 'application/json' }),
    );
    await user.click(await screen.findByRole('button', { name: 'Confirm import' }));
    expect(stored().readings).toHaveLength(2);
    expect(stored().readings).toEqual(expect.arrayContaining([sibling, edited]));
  });

  it('preserves unreadable storage on export and import and still allows a new draw', async () => {
    localStorage.setItem(STORAGE_KEY, '{broken');
    const user = userEvent.setup();
    useSecureSamples();
    renderApp(<TestApp />);
    expect(screen.getByRole('alert')).toHaveTextContent('Saved data could not be read');
    await user.click(journalButton());
    await user.click(screen.getByRole('button', { name: 'Export journal' }));
    expect(
      await screen.findByText(/saved journal could not be read to create a backup/i),
    ).toHaveAttribute('role', 'alert');
    expect(screen.queryByRole('link', { name: 'Download backup' })).not.toBeInTheDocument();
    await user.upload(
      screen.getByLabelText('Journal backup file'),
      new File(['{"version":1,"readings":[]}'], 'backup.json', { type: 'application/json' }),
    );
    expect(await screen.findByText(/saved journal could not be read to merge/i)).toBeVisible();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('{broken');
    await user.click(screen.getByRole('link', { name: 'Reading' }));
    await user.click(drawButton());
    expect(stored().readings).toHaveLength(1);
    expect(localStorage.getItem(RECOVERY_KEY)).toBe('{broken');
  });

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
      expect(text).toContain(`${index + 1}. ${CARD_BY_ID.get(card.cardId)!.name} — Upright`),
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
});
