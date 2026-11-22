import { describe, expect, it } from 'vitest';
import { cardById, tarotDeck } from '@/features/Tarot/data/deck';

describe('the complete standard deck', () => {
  it('contains 78 stable unique IDs and 22 distinct Major Arcana', () => {
    expect(tarotDeck).toHaveLength(78);
    expect(new Set(tarotDeck.map((card) => card.id)).size).toBe(78);
    expect(cardById.size).toBe(78);
    const major = tarotDeck.filter((card) => card.arcana === 'major');
    expect(major).toHaveLength(22);
    expect(major.map((card) => card.rank)).toEqual(Array.from({ length: 22 }, (_, index) => index));
    expect(major.map((card) => card.name)).toEqual([
      'The Fool',
      'The Magician',
      'The High Priestess',
      'The Empress',
      'The Emperor',
      'The Hierophant',
      'The Lovers',
      'The Chariot',
      'Strength',
      'The Hermit',
      'Wheel of Fortune',
      'Justice',
      'The Hanged Man',
      'Death',
      'Temperance',
      'The Devil',
      'The Tower',
      'The Star',
      'The Moon',
      'The Sun',
      'Judgement',
      'The World',
    ]);
    expect(major.every((card) => /^major-\d{2}$/.test(card.id))).toBe(true);
  });

  it('contains Ace through King exactly once in each of four suits', () => {
    const ranks = [
      'Ace',
      'Two',
      'Three',
      'Four',
      'Five',
      'Six',
      'Seven',
      'Eight',
      'Nine',
      'Ten',
      'Page',
      'Knight',
      'Queen',
      'King',
    ];
    expect(tarotDeck.filter((card) => card.arcana === 'minor')).toHaveLength(56);
    for (const suit of ['Wands', 'Cups', 'Swords', 'Pentacles']) {
      const cards = tarotDeck.filter((card) => card.suit === suit);
      expect(cards.map((card) => card.rank)).toEqual(
        Array.from({ length: 14 }, (_, index) => index + 1),
      );
      expect(cards.map((card) => card.name)).toEqual(ranks.map((rank) => `${rank} of ${suit}`));
      expect(cards.map((card) => card.id)).toEqual(
        ranks.map(
          (_, index) => `minor-${suit.toLowerCase()}-${String(index + 1).padStart(2, '0')}`,
        ),
      );
    }
  });

  it('provides complete, distinct upright and reversed wording for every card', () => {
    for (const card of tarotDeck) {
      expect(card.upright.keywords.length).toBeGreaterThanOrEqual(3);
      expect(card.reversed.keywords.length).toBeGreaterThanOrEqual(3);
      expect(card.upright.meaning.length).toBeGreaterThan(50);
      expect(card.reversed.meaning.length).toBeGreaterThan(50);
      expect(card.upright.meaning).not.toBe(card.reversed.meaning);
      expect(cardById.get(card.id)).toBe(card);
    }
    expect(
      new Set(tarotDeck.flatMap((card) => [card.upright.meaning, card.reversed.meaning])).size,
    ).toBe(156);
  });
});
