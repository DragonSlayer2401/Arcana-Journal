import { cardById } from '@/features/Tarot/data/deck';
import type { Reading } from '@/features/Journal/readingTypes';

export const formatReading = (reading: Reading): string =>
  [
    'Arcana Journal — Tarot Reading',
    new Date(reading.createdAt).toLocaleString(),
    '',
    `Question: ${reading.question || 'Open reading'}`,
    '',
    ...reading.cards.map(
      (draw, i) =>
        `${i + 1}. ${cardById.get(draw.cardId)!.name} — ${draw.orientation === 'upright' ? 'Upright' : 'Reversed'}`,
    ),
    '',
    'Cards are listed in draw order. Please interpret this spread as a reflection on the question.',
  ].join('\n');
