import { isReading } from './storage';
import type { Reading } from './types';

const BACKUP_VERSION = 1;
export const backupNeedsSizeConfirmation = (bytes: number): boolean => bytes > 64 * 1024 * 1024;

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

export const sameReadingContent = (left: Reading, right: Reading): boolean =>
  Date.parse(left.createdAt) === Date.parse(right.createdAt) &&
  left.question === right.question &&
  left.cards.length === right.cards.length &&
  left.cards.every(
    (card, index) =>
      card.cardId === right.cards[index].cardId &&
      card.orientation === right.cards[index].orientation,
  );

export const mergeReveals = (existing: Reading, incoming: Reading): Reading => {
  if (!incoming.revealed.some((shown, index) => shown && !existing.revealed[index]))
    return existing;
  return {
    ...existing,
    revealed: existing.revealed.map((shown, index) => shown || incoming.revealed[index]),
  };
};

// A legacy timestamp ID can represent different draws on different devices. Derive a
// repeatable alternate ID from the draw; revealing a card must never change that ID.
export const collisionReadingId = async (reading: Reading, attempt = 0): Promise<string> => {
  const identity = JSON.stringify([
    reading.id,
    Date.parse(reading.createdAt),
    reading.question,
    reading.cards.map(({ cardId, orientation }) => [cardId, orientation]),
    attempt,
  ]);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  const hex = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  return `import-${hex}`;
};

export const resolveImportReading = async (
  source: Reading,
  lookup: (id: string) => Reading | undefined | Promise<Reading | undefined>,
): Promise<{ id: string; existing: Reading | undefined }> => {
  const primary = await lookup(source.id);
  if (primary && sameReadingContent(primary, source)) return { id: source.id, existing: primary };
  for (let attempt = 0; ; attempt++) {
    const alternateId = await collisionReadingId(source, attempt);
    const alternate = await lookup(alternateId);
    if (!alternate) return { id: primary ? alternateId : source.id, existing: undefined };
    if (sameReadingContent(alternate, source)) return { id: alternateId, existing: alternate };
  }
};

export const mergeJournalReadings = async (existing: Reading[], incoming: Reading[]) => {
  const byId = new Map(existing.map((reading) => [reading.id, reading]));
  let hasAlternateIds = existing.some(({ id }) => id.startsWith('import-'));
  let added = 0;
  let skipped = 0;
  let updated = 0;
  for (const source of incoming) {
    const target =
      !hasAlternateIds && !byId.has(source.id)
        ? { id: source.id, existing: undefined }
        : await resolveImportReading(source, (id) => byId.get(id));
    if (!target.existing) {
      byId.set(target.id, { ...source, id: target.id });
      if (target.id.startsWith('import-')) hasAlternateIds = true;
      added++;
      continue;
    }
    const merged = mergeReveals(target.existing, source);
    if (merged === target.existing) skipped++;
    else {
      byId.set(target.id, merged);
      updated++;
    }
  }
  const readings =
    added || updated
      ? [...byId.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      : existing;
  return { readings, added, skipped, updated };
};
