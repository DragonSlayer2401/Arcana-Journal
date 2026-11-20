import { CARD_BY_ID } from '../data/deck';
import type { Reading, Settings } from './types';

export const STORAGE_KEY = 'stilllight.tarot.v1';
export const RECOVERY_KEY = STORAGE_KEY + '.recovery';
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
export const isReading = (value: unknown): value is Reading => {
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
const parseSavedData = (raw: string): AppData => {
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
  return parsed;
};

// Most writes follow a successful read or write in this tab. Recheck the shape
// when another tab (including a newer app version) has replaced the value.
let lastValidRaw: string | null = null;
export const loadData = (): { data: AppData; warning: string } => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return { data: freshData(), warning: '' };
    const data = parseSavedData(raw);
    lastValidRaw = raw;
    return { data, warning: '' };
  } catch {
    return {
      data: freshData(),
      warning:
        'Saved data could not be read. You can still draw here. If you have a journal backup, you can import it in another browser.',
    };
  }
};
export const saveData = (data: AppData): string => {
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing !== null && existing !== lastValidRaw) {
      try {
        parseSavedData(existing);
      } catch {
        // Save the exact unreadable source before persisting this session's new
        // journal. A full/disabled store throws here, leaving the source intact.
        let key = RECOVERY_KEY;
        for (let copy = 1; ; copy++) {
          const previous = localStorage.getItem(key);
          if (previous === existing) break;
          if (previous === null) {
            localStorage.setItem(key, existing);
            break;
          }
          key = RECOVERY_KEY + '.' + copy;
        }
      }
    }
    const raw = JSON.stringify(data);
    localStorage.setItem(STORAGE_KEY, raw);
    lastValidRaw = raw;
    return '';
  } catch {
    return 'This device could not save your reading or settings. Your cards are still available in this session. Open Journal and choose Export journal before leaving.';
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
