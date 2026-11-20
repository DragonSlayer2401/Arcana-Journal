import { CARD_BY_ID } from '../data/deck';
import type { Reading, Settings } from './types';

export const STORAGE_KEY = 'stilllight.tarot.v1';
export interface AppData {
  version: 1;
  settings: Settings;
  readings: Reading[];
  activeId: string | null;
  awaitingNewReading: boolean;
}
export const freshData = (): AppData => ({
  version: 1,
  settings: { mode: 'three', customCount: 5, reversals: false },
  readings: [],
  activeId: null,
  awaitingNewReading: false,
});
const isReading = (value: unknown): value is Reading => {
  if (!value || typeof value !== 'object') return false;
  const r = value as Reading;
  return (
    typeof r.id === 'string' &&
    typeof r.question === 'string' &&
    typeof r.createdAt === 'string' &&
    Number.isFinite(Date.parse(r.createdAt)) &&
    Array.isArray(r.cards) &&
    r.cards.length >= 1 &&
    r.cards.length <= 10 &&
    r.cards.every(
      (c) => c && CARD_BY_ID.has(c.cardId) && ['upright', 'reversed'].includes(c.orientation),
    ) &&
    new Set(r.cards.map((c) => c.cardId)).size === r.cards.length &&
    Array.isArray(r.revealed) &&
    r.revealed.length === r.cards.length &&
    r.revealed.every((v) => typeof v === 'boolean')
  );
};
export const loadData = (): { data: AppData; warning: string } => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { data: freshData(), warning: '' };
    const parsed = JSON.parse(raw) as AppData;
    if (
      parsed.version !== 1 ||
      !Array.isArray(parsed.readings) ||
      !parsed.readings.every(isReading) ||
      new Set(parsed.readings.map((r) => r.id)).size !== parsed.readings.length ||
      !parsed.settings ||
      !['one', 'three', 'custom'].includes(parsed.settings.mode) ||
      !Number.isInteger(parsed.settings.customCount) ||
      parsed.settings.customCount < 1 ||
      parsed.settings.customCount > 10 ||
      typeof parsed.settings.reversals !== 'boolean' ||
      typeof parsed.awaitingNewReading !== 'boolean' ||
      !(parsed.activeId === null || parsed.readings.some((r) => r.id === parsed.activeId))
    ) {
      throw new Error('Invalid saved data');
    }
    return { data: parsed, warning: '' };
  } catch {
    return {
      data: freshData(),
      warning:
        'Saved data could not be read. You can still draw here, but previous history may be unavailable. Use Copy Reading to keep a separate copy.',
    };
  }
};
export const saveData = (data: AppData): string => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return '';
  } catch {
    return 'This device could not save your reading or settings. Your cards are still available in this session. Use Copy Reading before leaving.';
  }
};
export const formatReading = (reading: Reading): string =>
  [
    'Arcana Journal — Tarot Reading',
    new Date(reading.createdAt).toLocaleString(),
    '',
    `Question: ${reading.question || 'Open reading'}`,
    '',
    ...reading.cards.map(
      (draw, i) =>
        `${i + 1}. ${CARD_BY_ID.get(draw.cardId)!.name} — ${draw.orientation === 'upright' ? 'Upright' : 'Reversed'}`,
    ),
    '',
    'Cards are listed in draw order. Please interpret this spread as a reflection on the question.',
  ].join('\n');
