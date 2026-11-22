import { isReading } from './readingValidation';
import { readingEpoch } from './readingDate';
import { sameReadingContent } from './readingIdentity';
import type { Reading } from '../readingTypes';

const backupVersion = 1;
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
      ...(value.sourceId && { sourceId: value.sourceId }),
      createdAt: new Date(readingEpoch(value.createdAt)).toISOString(),
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
  return JSON.stringify({ version: backupVersion, readings }, null, 2);
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
  if (backup.version !== backupVersion) {
    throw new Error('This journal backup version is unsupported.');
  }
  const readings: Reading[] = [];
  appendReadings(readings, new Set(), 'readings' in backup ? backup.readings : undefined);
  return readings;
};

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
    reading.sourceId ?? reading.id,
    readingEpoch(reading.createdAt),
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

export const assignReadingId = (reading: Reading, id: string): Reading =>
  id === reading.id ? reading : { ...reading, id, sourceId: reading.sourceId ?? reading.id };

// Backups made before sourceId existed carry only the derived ID. A matching
// original on the destination can prove that relationship by recomputing it.
// Two explicitly listed copies of the same spread must remain independent.
export const originalForLegacyAlternate = async (
  source: Reading,
  candidates: Reading[],
  incomingById: ReadonlyMap<string, Reading>,
) => {
  if (source.sourceId || !/^import-[\da-f]{64}(?:-[1-9]\d*)?$/.test(source.id)) return;
  let uncertain = false;
  for (const candidate of candidates) {
    if (
      (candidate.sourceId && candidate.sourceId !== candidate.id) ||
      candidate.id === source.id ||
      !sameReadingContent(candidate, source)
    )
      continue;
    const listed = incomingById.get(candidate.id);
    if (!listed || sameReadingContent(listed, source)) continue;
    uncertain = true;
    const base = await collisionReadingId(candidate);
    if (source.id === base || source.id.startsWith(base + '-')) return candidate;
    if (source.id.length === base.length) {
      for (let attempt = 1; attempt <= 64; attempt++) {
        if (source.id === (await collisionReadingId(candidate, attempt))) return candidate;
      }
    }
  }
  if (uncertain) throw new Error(unverifiedImportMessage);
};

// New alternate IDs share the source fingerprint. This preserves the link even
// when every earlier occupant has been deleted and no local receipt survives.
export const unverifiedImportMessage =
  'An older imported reading has the same spread. Its original ID could not be verified. Keep your source backup and compare the two readings before choosing which copy to keep.';

export const findImportTarget = async (
  source: Reading,
  candidates: Reading[],
  requireCertain = false,
  explicitIds?: ReadonlyMap<string, Reading>,
) => {
  const origin = source.sourceId ?? source.id;
  const ids = new Set<string>();
  for (const reading of candidates) {
    if (explicitIds?.has(reading.id) || !sameReadingContent(reading, source)) continue;
    if (reading.sourceId === origin) return reading.id;
    if (!reading.sourceId && reading.id.startsWith('import-')) ids.add(reading.id);
  }
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
  explicitIds?: ReadonlyMap<string, Reading>,
): Promise<{ id: string; existing: Reading | undefined }> => {
  const origin = source.sourceId ?? source.id;
  const matchesOrigin = (reading: Reading) =>
    (!reading.sourceId || reading.sourceId === origin) && sameReadingContent(reading, source);
  const primary = await lookup(source.id);
  // An older backup can name the assigned ID without carrying its origin.
  if (primary && (source.sourceId ? matchesOrigin(primary) : sameReadingContent(primary, source)))
    return { id: source.id, existing: primary };
  const listedOriginal = source.sourceId && explicitIds?.get(source.sourceId);
  if (
    source.sourceId &&
    importedAs !== source.id &&
    (!listedOriginal || !sameReadingContent(listedOriginal, source))
  ) {
    const original = await lookup(source.sourceId);
    if (original && matchesOrigin(original)) return { id: original.id, existing: original };
  }
  // A receipt locates a past collision when the file's own ID is missing or occupied.
  if (importedAs && importedAs !== source.id && !explicitIds?.has(importedAs)) {
    const mapped = await lookup(importedAs);
    if (mapped && matchesOrigin(mapped)) return { id: importedAs, existing: mapped };
  }
  const base = await collisionReadingId(source);
  let firstFree: string | undefined;
  for (let attempt = 0; ; attempt++) {
    const alternateId = attempt ? `${base}-${attempt}` : base;
    const reserved = explicitIds?.has(alternateId);
    const alternate = await lookup(alternateId);
    if (!reserved && alternate && matchesOrigin(alternate))
      return { id: alternateId, existing: alternate };
    if (!reserved && !alternate) firstFree ??= alternateId;
    if (attempt) {
      const previousId = await collisionReadingId(source, attempt);
      const previous = await lookup(previousId);
      if (!explicitIds?.has(previousId) && previous && matchesOrigin(previous))
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
  const incomingById = new Map(incoming.map((reading) => [reading.id, reading]));
  const candidatesByDate = new Map<number, Reading[]>();
  const alternatesByDate = new Map<number, Reading[]>();
  const indexReading = (reading: Reading) => {
    const date = readingEpoch(reading.createdAt);
    const candidates = candidatesByDate.get(date) ?? [];
    candidates.push(reading);
    candidatesByDate.set(date, candidates);
    if (!reading.sourceId && !reading.id.startsWith('import-')) return;
    const alternatives = alternatesByDate.get(date) ?? [];
    alternatives.push(reading);
    alternatesByDate.set(date, alternatives);
  };
  existing.forEach(indexReading);
  let added = 0;
  let skipped = 0;
  let updated = 0;
  for (const source of incoming) {
    // A local receipt already names its destination. An unrelated legacy ID
    // with the same spread should never prevent backing up that reading.
    const assigned = assignedIds?.has(source.id);
    const alternatives = assigned
      ? undefined
      : alternatesByDate.get(readingEpoch(source.createdAt));
    let target =
      !alternatives && !byId.has(source.id) && (assigned || !source.sourceId)
        ? { id: source.id, existing: undefined }
        : await resolveImportReading(
            source,
            (id) => byId.get(id),
            assigned ? source.id : undefined,
            incomingById,
          );
    if (!target.existing && !assigned) {
      const original = await originalForLegacyAlternate(
        source,
        candidatesByDate.get(readingEpoch(source.createdAt)) ?? [],
        incomingById,
      );
      if (original) target = { id: original.id, existing: byId.get(original.id) };
    }
    if (!target.existing && alternatives) {
      const previousId = await findImportTarget(source, alternatives, true, incomingById);
      if (previousId) target = { id: previousId, existing: byId.get(previousId) };
    }
    if (!target.existing) {
      const addedReading = assignReadingId(source, target.id);
      byId.set(target.id, addedReading);
      indexReading(addedReading);
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
      ? [...byId.values()].sort((a, b) => readingEpoch(b.createdAt) - readingEpoch(a.createdAt))
      : existing;
  return { readings, added, skipped, updated };
};
