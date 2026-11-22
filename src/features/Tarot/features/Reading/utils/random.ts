import type { DrawnCard } from '@/features/Tarot/cardTypes';

// Ordinary number arithmetic is intentional: bitwise operators truncate 2 ** 32.
const uint32Range = 2 ** 32;
const secureRandomErrorMessage =
  'Secure randomness is unavailable. No cards were drawn. Please open this app in an up-to-date browser using its HTTPS address.';

/** An unbiased integer in [0, upperBound), using only Web Crypto. */
export const secureRandomInt = (upperBound: number): number => {
  if (!Number.isInteger(upperBound) || upperBound < 1 || upperBound > uint32Range) {
    throw new RangeError('The random integer bound must be an integer from 1 to 2 ** 32.');
  }

  const crypto = globalThis.crypto;
  if (!crypto || typeof crypto.getRandomValues !== 'function') {
    throw new Error(secureRandomErrorMessage);
  }

  const limit = Math.floor(uint32Range / upperBound) * upperBound;
  const sample = new Uint32Array(1);
  do {
    try {
      crypto.getRandomValues(sample);
    } catch {
      // Do not silently replace Web Crypto with a weaker source.
      throw new Error(secureRandomErrorMessage);
    }
  } while (sample[0] >= limit);

  return sample[0] % upperBound;
};

/** Unbiased Fisher–Yates on a fresh copy; never mutates the supplied deck. */
export const shuffleDeck = <T>(deck: readonly T[]): T[] => {
  const shuffled = [...deck];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const otherIndex = secureRandomInt(index + 1);
    [shuffled[index], shuffled[otherIndex]] = [shuffled[otherIndex], shuffled[index]];
  }
  return shuffled;
};

/**
 * Pass all 78 stable card IDs for every new reading. Shuffle exactly once,
 * then take the requested cards. This module accepts no question, meanings,
 * previous readings, animation state, or seeds; repeat readings are allowed.
 */
export const drawCards = (
  cardIds: readonly string[],
  count: number,
  reversals = false,
): DrawnCard[] => {
  if (!Number.isInteger(count) || count < 1 || count > 10 || count > cardIds.length) {
    throw new RangeError('Choose a whole number of cards from 1 to 10, within the deck size.');
  }
  if (new Set(cardIds).size !== cardIds.length) {
    throw new Error('The deck must contain unique card IDs.');
  }
  const selected = shuffleDeck(cardIds).slice(0, count);
  return selected.map((cardId) => ({
    cardId,
    orientation: reversals && secureRandomInt(2) === 1 ? 'reversed' : 'upright',
  }));
};
