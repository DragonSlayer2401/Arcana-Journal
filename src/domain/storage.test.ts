import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DECK } from '../data/deck';
import {
  formatReading,
  freshData,
  loadData,
  RECOVERY_KEY,
  saveData,
  STORAGE_KEY,
  type AppData,
} from './storage';

const savedData = (): AppData => ({
  ...freshData(),
  settings: { mode: 'custom', customCount: 2, reversals: true },
  activeId: 'reading-1',
  readings: [
    {
      id: 'reading-1',
      question: 'What could I notice?',
      createdAt: '2026-11-19T18:00:00.000Z',
      cards: [
        { cardId: DECK[0].id, orientation: 'upright' },
        { cardId: DECK[1].id, orientation: 'reversed' },
      ],
      revealed: [true, false],
    },
  ],
});
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('local reading persistence', () => {
  it('starts with three upright-only cards and no history', () => {
    expect(loadData()).toEqual({ data: freshData(), warning: '' });
    expect(loadData().data.settings).toMatchObject({ mode: 'three', reversals: false });
  });

  it('round trips questions, dates, card order, orientations, reveals, active reading and settings', () => {
    const original = savedData();
    expect(saveData(original)).toBe('');
    expect(loadData()).toEqual({ data: original, warning: '' });
  });

  it.each([
    ['malformed JSON', '{broken'],
    ['null JSON', 'null'],
    ['unknown schema', JSON.stringify({ ...savedData(), version: 2 })],
    ['orphan active reading', JSON.stringify({ ...savedData(), activeId: 'missing' })],
    [
      'unknown card',
      JSON.stringify({
        ...savedData(),
        readings: [
          {
            ...savedData().readings[0],
            cards: [{ cardId: 'missing', orientation: 'upright' }],
            revealed: [false],
          },
        ],
      }),
    ],
    [
      'duplicate card',
      JSON.stringify({
        ...savedData(),
        readings: [
          {
            ...savedData().readings[0],
            cards: [savedData().readings[0].cards[0], savedData().readings[0].cards[0]],
          },
        ],
      }),
    ],
    [
      'invalid orientation',
      JSON.stringify({
        ...savedData(),
        readings: [
          {
            ...savedData().readings[0],
            cards: [{ cardId: DECK[0].id, orientation: 'sideways' }],
            revealed: [false],
          },
        ],
      }),
    ],
    [
      'invalid reveal state',
      JSON.stringify({
        ...savedData(),
        readings: [{ ...savedData().readings[0], revealed: [true] }],
      }),
    ],
    [
      'duplicate reading identity',
      JSON.stringify({
        ...savedData(),
        readings: [savedData().readings[0], savedData().readings[0]],
      }),
    ],
  ])('recovers from %s without throwing or silently claiming history was loaded', (_, raw) => {
    localStorage.setItem(STORAGE_KEY, raw);
    const result = loadData();
    expect(result.data).toEqual(freshData());
    expect(result.warning).toContain('Saved data could not be read');
    expect(localStorage.getItem(STORAGE_KEY)).toBe(raw);
  });

  it('returns usable defaults if reading browser storage is forbidden', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage denied', 'SecurityError');
    });
    expect(loadData().data).toEqual(freshData());
    expect(loadData().warning).toContain('Saved data could not be read');
  });

  it('preserves unreadable or newer journals when the user keeps drawing', () => {
    const original = savedData();
    saveData(original);
    const newer = JSON.stringify({ ...original, version: 2 });
    localStorage.setItem(STORAGE_KEY, newer);
    expect(saveData(freshData())).toBe('');
    expect(localStorage.getItem(RECOVERY_KEY)).toBe(newer);
    localStorage.setItem(STORAGE_KEY, '{invalid');
    expect(loadData().warning).toContain('Saved data could not be read');
    expect(saveData(original)).toBe('');
    expect(localStorage.getItem(RECOVERY_KEY)).toBe(newer);
    expect(localStorage.getItem(RECOVERY_KEY + '.1')).toBe('{invalid');
    expect(loadData()).toEqual({ data: original, warning: '' });
  });

  it('retains the damaged source untouched when there is no space for its recovery copy', () => {
    localStorage.setItem(STORAGE_KEY, '{broken');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    expect(saveData(savedData())).toContain('Your cards are still available in this session');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('{broken');
  });

  it('reports write failure without mutating the caller’s complete reading', () => {
    const original = savedData();
    const snapshot = structuredClone(original);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    expect(saveData(original)).toContain('Your cards are still available in this session');
    expect(original).toEqual(snapshot);
  });

  it('exports the question, draw order and both saved orientations without requiring reveal', () => {
    const reading = savedData().readings[0];
    const text = formatReading(reading);
    expect(text).toContain('Question: What could I notice?');
    expect(text).toContain(`1. ${DECK[0].name} — Upright\n2. ${DECK[1].name} — Reversed`);
    expect(text).toContain('Cards are listed in draw order.');
    expect(formatReading({ ...reading, question: '' })).toContain('Question: Open reading');
  });
});
