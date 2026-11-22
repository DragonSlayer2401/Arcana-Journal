import type { Reading } from '../readingTypes';
import { readingEpoch } from './readingDate';

export const sameReadingContent = (left: Reading, right: Reading): boolean =>
  readingEpoch(left.createdAt) === readingEpoch(right.createdAt) &&
  left.question === right.question &&
  left.cards.length === right.cards.length &&
  left.cards.every(
    (card, index) =>
      card.cardId === right.cards[index].cardId &&
      card.orientation === right.cards[index].orientation,
  );
