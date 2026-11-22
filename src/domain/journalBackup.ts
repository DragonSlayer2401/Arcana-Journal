import { isReading } from './storage';
import type { Reading } from './types';

const BACKUP_VERSION = 1;
export class UncheckedDeletionsExportError extends Error {}
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

// New alternate IDs share the source fingerprint. This preserves the link even
// when every earlier occupant has been deleted and no local receipt survives.
export const unverifiedImportMessage =
  'An older imported reading has the same spread. Its original ID could not be verified. Keep your source backup and compare the two readings before choosing which copy to keep.';

export const findImportTarget = async (
  source: Reading,
  candidates: Reading[],
  requireCertain = false,
  explicitIds?: ReadonlySet<string>,
) => {
  const ids = new Set(
    candidates
      .filter(
        (r) =>
          r.id.startsWith('import-') && !explicitIds?.has(r.id) && sameReadingContent(r, source),
      )
      .map((r) => r.id),
  );
  if (!ids.size) return undefined;
  const base = await collisionReadingId(source);
  if (ids.has(base)) return base;
  for (const id of ids) {
    if (id.startsWith(base + '-') && /^[1-9]\d*$/.test(id.slice(base.length + 1))) return id;
  }
  // Historic IDs hashed the attempt number too. Never assume that an unrelated
  // portable ID belongs to this source merely because its spread looks the same.
  if (Array.from(ids).some((id) => /^import-[\da-f]{64}$/.test(id))) {
    for (let attempt = 1; attempt <= 64; attempt++) {
      const oldId = await collisionReadingId(source, attempt);
      if (ids.has(oldId)) return oldId;
    }
    if (requireCertain) throw new Error(unverifiedImportMessage);
  }
  return undefined;
};

export const resolveImportReading = async (
  source: Reading,
  lookup: (id: string) => Reading | undefined | Promise<Reading | undefined>,
  importedAs?: string,
  explicitIds?: ReadonlySet<string>,
): Promise<{ id: string; existing: Reading | undefined }> => {
  const primary = await lookup(source.id);
  if (primary && sameReadingContent(primary, source)) return { id: source.id, existing: primary };
  // A receipt locates a past collision when the file's own ID is missing or occupied.
  if (importedAs && importedAs !== source.id && !explicitIds?.has(importedAs)) {
    const mapped = await lookup(importedAs);
    if (mapped && sameReadingContent(mapped, source)) return { id: importedAs, existing: mapped };
  }
  const base = await collisionReadingId(source);
  let firstFree: string | undefined;
  for (let attempt = 0; ; attempt++) {
    const alternateId = attempt ? `${base}-${attempt}` : base;
    const reserved = explicitIds?.has(alternateId);
    const alternate = await lookup(alternateId);
    if (!reserved && alternate && sameReadingContent(alternate, source))
      return { id: alternateId, existing: alternate };
    if (!reserved && !alternate) firstFree ??= alternateId;
    if (attempt) {
      const previousId = await collisionReadingId(source, attempt);
      const previous = await lookup(previousId);
      if (!explicitIds?.has(previousId) && previous && sameReadingContent(previous, source))
        return { id: previousId, existing: previous };
      if (previous) continue;
    }
    if (!reserved && !alternate)
      return { id: primary ? firstFree! : source.id, existing: undefined };
  }
};

export const mergeJournalReadings = async (
  existing: Reading[],
  incoming: Reading[],
  assignedIds?: ReadonlySet<string>,
) => {
  const byId = new Map(existing.map((reading) => [reading.id, reading]));
  const explicitIds = new Set(incoming.map((reading) => reading.id));
  const alternatesByDate = new Map<number, Reading[]>();
  const indexAlternate = (reading: Reading) => {
    if (!reading.id.startsWith('import-')) return;
    const date = Date.parse(reading.createdAt);
    const alternatives = alternatesByDate.get(date) ?? [];
    alternatives.push(reading);
    alternatesByDate.set(date, alternatives);
  };
  existing.forEach(indexAlternate);
  let added = 0;
  let skipped = 0;
  let updated = 0;
  for (const source of incoming) {
    // A local receipt already names its destination. An unrelated legacy ID
    // with the same spread should never prevent backing up that reading.
    const alternatives = assignedIds?.has(source.id)
      ? undefined
      : alternatesByDate.get(Date.parse(source.createdAt));
    let target =
      !alternatives && !byId.has(source.id)
        ? { id: source.id, existing: undefined }
        : await resolveImportReading(source, (id) => byId.get(id), undefined, explicitIds);
    if (!target.existing && alternatives) {
      const previousId = await findImportTarget(source, alternatives, true, explicitIds);
      if (previousId) target = { id: previousId, existing: byId.get(previousId) };
    }
    if (!target.existing) {
      const addedReading = { ...source, id: target.id };
      byId.set(target.id, addedReading);
      indexAlternate(addedReading);
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
