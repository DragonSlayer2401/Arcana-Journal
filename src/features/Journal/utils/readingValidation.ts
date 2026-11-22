import { cardById } from '@/features/Tarot/data/deck';
import { readingEpoch } from './readingDate';
import type { Reading } from '../readingTypes';

export const isReading = (value: unknown): value is Reading => {
  if (!value || typeof value !== 'object') return false;
  const r = value as Reading;
  return (
    typeof r.id === 'string' &&
    (r.sourceId === undefined || (typeof r.sourceId === 'string' && r.sourceId.trim() !== '')) &&
    typeof r.question === 'string' &&
    typeof r.createdAt === 'string' &&
    Number.isFinite(readingEpoch(r.createdAt)) &&
    Array.isArray(r.cards) &&
    r.cards.length >= 1 &&
    r.cards.length <= 10 &&
    r.cards.every(
      (c) => c && cardById.has(c.cardId) && ['upright', 'reversed'].includes(c.orientation),
    ) &&
    new Set(r.cards.map((c) => c.cardId)).size === r.cards.length &&
    Array.isArray(r.revealed) &&
    r.revealed.length === r.cards.length &&
    r.revealed.every((v) => typeof v === 'boolean')
  );
};
