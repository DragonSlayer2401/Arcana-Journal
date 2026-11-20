import { isReading } from './storage';
import type { Reading } from './types';

const BACKUP_VERSION = 1;

export interface JournalPageData {
  readings: Reading[];
  nextCursor: string | null;
}

export type ReadJournalPage = (cursor: string | null) => JournalPageData | Promise<JournalPageData>;

// Only portable reading fields belong in a backup, even if a future source includes account metadata.
const appendReadings = (readings: Reading[], seenIds: Set<string>, values: unknown) => {
  if (!Array.isArray(values)) throw new Error('The journal must contain a list of readings.');
  for (const value of values) {
    const position = readings.length + 1;
    if (!isReading(value) || !value.id.trim()) {
      throw new Error(`Reading ${position} has invalid or missing reading data.`);
    }
    if (seenIds.has(value.id)) {
      throw new Error(`Reading ${position} has a duplicate reading ID.`);
    }
    seenIds.add(value.id);
    readings.push({
      id: value.id,
      createdAt: value.createdAt,
      question: value.question,
      cards: value.cards.map(({ cardId, orientation }) => ({ cardId, orientation })),
      revealed: [...value.revealed],
    });
  }
};

export const createJournalBackup = async (readPage: ReadJournalPage): Promise<string> => {
  const readings: Reading[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: JournalPageData = await readPage(cursor);
    if (!page || (page.nextCursor !== null && typeof page.nextCursor !== 'string')) {
      throw new Error('The journal returned an invalid page.');
    }
    appendReadings(readings, seenIds, page.readings);
    cursor = page.nextCursor;
    if (cursor !== null) {
      if (seenCursors.has(cursor)) throw new Error('The journal returned a repeated page.');
      seenCursors.add(cursor);
    }
  } while (cursor !== null);
  return JSON.stringify({ version: BACKUP_VERSION, readings }, null, 2);
};

export const parseJournalBackup = (json: string): Reading[] => {
  let backup: unknown;
  try {
    backup = JSON.parse(json.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('Choose a valid journal backup JSON file.');
  }
  if (!backup || typeof backup !== 'object' || !('version' in backup)) {
    throw new Error('The file is missing the journal backup version.');
  }
  if (backup.version !== BACKUP_VERSION) {
    throw new Error('This journal backup version is unsupported.');
  }
  const readings: Reading[] = [];
  appendReadings(readings, new Set(), 'readings' in backup ? backup.readings : undefined);
  return readings;
};

export const mergeJournalReadings = (existing: Reading[], incoming: Reading[]) => {
  const existingIds = new Set(existing.map((reading) => reading.id));
  const additions = incoming.filter((reading) => !existingIds.has(reading.id));
  const readings = additions.length
    ? [...existing, ...additions].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    : existing;
  return { readings, added: additions.length, skipped: incoming.length - additions.length };
};
