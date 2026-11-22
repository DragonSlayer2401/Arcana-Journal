import {
  assignReadingId,
  mergeReveals,
  resolveImportReading,
} from '@/features/Journal/utils/journalBackup';
import { sameReadingContent } from '@/features/Journal/utils/readingIdentity';
import { readingEpoch } from '@/features/Journal/utils/readingDate';
import type { Reading } from '@/features/Journal/readingTypes';

const unchanged = (base: Reading | undefined, reading: Reading) =>
  base &&
  sameReadingContent(base, reading) &&
  base.revealed.every((shown, index) => shown === reading.revealed[index]);

// These snapshots belong to one journal, so separate explicit IDs represent separate draws.
// Apply only the tab's edits to the latest saved readings, including confirmed deletions.
export const recoverGuestReadings = async (base: Reading[], draft: Reading[], saved: Reading[]) => {
  const original = new Map(base.map((reading) => [reading.id, reading]));
  const draftIds = new Set(draft.map((reading) => reading.id));
  const reserved = new Map([...draft, ...saved].map((reading) => [reading.id, reading]));
  const recovered = new Map(
    saved
      .filter(
        (reading) => draftIds.has(reading.id) || !unchanged(original.get(reading.id), reading),
      )
      .map((reading) => [reading.id, reading]),
  );
  for (const reading of draft) {
    if (unchanged(original.get(reading.id), reading)) continue;
    const latest = recovered.get(reading.id);
    if (!latest) {
      recovered.set(reading.id, reading);
    } else if (sameReadingContent(latest, reading)) {
      recovered.set(reading.id, mergeReveals(latest, reading));
    } else {
      const { id } = await resolveImportReading(
        reading,
        (id) => recovered.get(id),
        undefined,
        reserved,
      );
      recovered.set(id, assignReadingId(reading, id));
    }
  }
  return [...recovered.values()].sort(
    (a, b) => readingEpoch(b.createdAt) - readingEpoch(a.createdAt),
  );
};
