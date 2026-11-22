import type { Reading, Settings } from '@/features/Journal/readingTypes';
import { tarotDeck } from '@/features/Tarot/data/deck';
import { drawCards } from './random';

const cardIds = Object.freeze(tarotDeck.map((card) => card.id));

export const getSpreadCount = ({ mode, customCount }: Settings) =>
  mode === 'one' ? 1 : mode === 'three' ? 3 : customCount;

export const createReading = (settings: Settings, question: string): Reading => {
  const cards = drawCards(cardIds, getSpreadCount(settings), settings.reversals);
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    question: question.trim(),
    cards,
    revealed: cards.map(() => settings.instantReveal),
  };
};
