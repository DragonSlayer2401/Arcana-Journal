import { afterEach, describe, expect, it, vi } from 'vitest';
import { drawCards, secureRandomInt, shuffleDeck } from './random';

/** Controlled sources exist only in tests; production has no injectable RNG. */
const useSamples = (values: readonly number[]) => {
  let next = 0;
  return vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((target) => {
    if (!(target instanceof Uint32Array) || target.length !== 1) {
      throw new Error('Expected exactly one unsigned 32-bit sample.');
    }
    if (next >= values.length) throw new Error('The controlled sample stream was exhausted.');
    target[0] = values[next++];
    return target;
  });
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('secure bounded integers', () => {
  it.each([0, -1, 1.5, NaN, Infinity, -Infinity, 2 ** 32 + 1])(
    'rejects invalid bound %s before consuming randomness',
    (bound) => {
      const source = useSamples([]);
      expect(() => secureRandomInt(bound)).toThrow(RangeError);
      expect(source).not.toHaveBeenCalled();
    },
  );

  it('handles both inclusive sample boundaries and the full 32-bit bound', () => {
    const source = useSamples([0, 2 ** 32 - 1, 2 ** 32 - 1, 0, 1]);
    expect(secureRandomInt(2 ** 32)).toBe(0);
    expect(secureRandomInt(2 ** 32)).toBe(2 ** 32 - 1);
    expect(secureRandomInt(1)).toBe(0);
    expect(secureRandomInt(2)).toBe(0);
    expect(secureRandomInt(2)).toBe(1);
    expect(source).toHaveBeenCalledTimes(5);
  });

  it('rejects a sample equal to the limit, then accepts limit minus one', () => {
    const source = useSamples([2 ** 32 - 1, 2 ** 32 - 2]);
    expect(secureRandomInt(3)).toBe(2);
    expect(source).toHaveBeenCalledTimes(2);
  });

  it('rejects every sample above the limit as well as the limit itself', () => {
    const bound = 2 ** 31 + 1;
    const source = useSamples([2 ** 32 - 1, bound, bound - 1]);
    expect(secureRandomInt(bound)).toBe(bound - 1);
    expect(source).toHaveBeenCalledTimes(3);
  });

  it('fails clearly when Web Crypto is absent', () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => secureRandomInt(78)).toThrow('Secure randomness is unavailable');
  });

  it('fails clearly when getRandomValues is absent', () => {
    vi.stubGlobal('crypto', {});
    expect(() => secureRandomInt(78)).toThrow('Secure randomness is unavailable');
  });

  it('fails clearly if the secure source throws, with no fallback', () => {
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(() => {
      throw new Error('Source failure');
    });
    expect(() => secureRandomInt(78)).toThrow('Secure randomness is unavailable');
  });
});

describe('Fisher–Yates', () => {
  it('produces each three-card permutation exactly once over all six valid choice sequences', () => {
    const permutations: string[] = [];
    for (let firstChoice = 0; firstChoice < 3; firstChoice += 1) {
      for (let secondChoice = 0; secondChoice < 2; secondChoice += 1) {
        const source = useSamples([firstChoice, secondChoice]);
        permutations.push(shuffleDeck(['a', 'b', 'c']).join(''));
        expect(source).toHaveBeenCalledTimes(2);
        source.mockRestore();
      }
    }
    expect(permutations.sort()).toEqual(['abc', 'acb', 'bac', 'bca', 'cab', 'cba']);
  });

  it('shuffles a new array without mutating the original deck', () => {
    const deck = Object.freeze(['a', 'b', 'c']);
    useSamples([0, 0]);
    const shuffled = shuffleDeck(deck);
    expect(shuffled).not.toBe(deck);
    expect(shuffled).toEqual(['b', 'c', 'a']);
    expect(deck).toEqual(['a', 'b', 'c']);
  });
});

describe('a complete reading', () => {
  const deck = Object.freeze(Array.from({ length: 78 }, (_, index) => `card-${index}`));

  it.each([1, 3, 10])('draws %s distinct cards after one full-deck shuffle', (count) => {
    const source = useSamples(Array(77).fill(0));
    const cards = drawCards(deck, count);
    expect(cards).toHaveLength(count);
    expect(new Set(cards.map((card) => card.cardId)).size).toBe(count);
    expect(cards.every((card) => deck.includes(card.cardId))).toBe(true);
    expect(source).toHaveBeenCalledTimes(77);
    expect(deck[0]).toBe('card-0');
  });

  it('permits identical complete spreads in separate readings using the full deck again', () => {
    const source = useSamples(Array(77 * 2).fill(0));
    const first = drawCards(deck, 3);
    const second = drawCards(deck, 3);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(source).toHaveBeenCalledTimes(154);
  });

  it('defaults every card to upright without consuming orientation samples', () => {
    const source = useSamples(Array(77).fill(0));
    expect(drawCards(deck, 10).every((card) => card.orientation === 'upright')).toBe(true);
    expect(source).toHaveBeenCalledTimes(77);
  });

  it('uses an independent unbiased 50/50 sample for each selected orientation when enabled', () => {
    const source = useSamples([...Array(77).fill(0), 0, 1, 2, 3]);
    const cards = drawCards(deck, 4, true);
    expect(cards.map((card) => card.orientation)).toEqual([
      'upright',
      'reversed',
      'upright',
      'reversed',
    ]);
    expect(source).toHaveBeenCalledTimes(81);
  });

  it.each([0, -1, 1.5, 11, NaN, Infinity])('rejects invalid spread count %s', (count) => {
    const source = useSamples([]);
    expect(() => drawCards(deck, count)).toThrow(RangeError);
    expect(source).not.toHaveBeenCalled();
  });

  it('rejects a count greater than the available deck and duplicate input IDs', () => {
    expect(() => drawCards(['a', 'b'], 3)).toThrow(RangeError);
    expect(() => drawCards(['a', 'a'], 2)).toThrow('unique card IDs');
  });

  it('creates no reading when secure randomness is unavailable', () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => drawCards(deck, 3)).toThrow('No cards were drawn');
  });
});
