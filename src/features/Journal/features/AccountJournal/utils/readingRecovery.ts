import {
  assignReadingId,
  findImportTarget,
  mergeReveals,
  resolveImportReading,
  unverifiedImportMessage,
} from '@/features/Journal/utils/journalBackup';
import { sameReadingContent } from '@/features/Journal/utils/readingIdentity';
import { isReading } from '@/features/Journal/utils/readingValidation';
import {
  hasTabRecoveryCopy,
  hasTabDeletionTarget,
  isTabRecoveryKey,
  loadTabRecoveryCopies,
  loadPreparedTabRecovery,
  removeTabRecoveryCopy,
  saveTabRecoveryCopy,
  setTabDeletionTarget,
  setTabImportTarget,
} from './tabRecovery';
import type { Reading } from '@/features/Journal/readingTypes';

export interface RecoveryCopy {
  key: string;
  reading: Reading;
  importedAs?: string;
}

export interface PreparedRecoveryCopy extends RecoveryCopy {
  targetId: string | null;
}

export const recoveryPrefix = (uid: string) =>
  'arcana.journal.recovery.v1:' + encodeURIComponent(uid) + ':';
const importReceiptPrefix = 'arcana.journal.import-target.v1:';
const importReceipt = (key: string) => importReceiptPrefix + key;
const retainedSuffix = ':retained';
export const isRetainedRecoveryCopy = (key: string) => key.endsWith(retainedSuffix);
export const recoveryKeysForCopy = (key: string) => {
  const keys = [key];
  while (isRetainedRecoveryCopy(key)) {
    key = key.slice(0, -retainedSuffix.length);
    keys.push(key);
  }
  return keys.reverse();
};
// Each retained copy supersedes its source, including a staged delete that
// still carries the old destination. Independent writes have unrelated keys.
export const authoritativeRecoveryCopies = <T extends RecoveryCopy>(
  copies: T[],
  inventory: RecoveryCopy[] = copies,
) => {
  const superseded = new Set(inventory.flatMap(({ key }) => recoveryKeysForCopy(key).slice(0, -1)));
  return copies.filter(({ key }) => !superseded.has(key));
};
const retainedRecord = (copy: RecoveryCopy) => ({
  retained: copy.reading,
  importedAs: copy.importedAs,
});
const isRetainedRecord = (value: unknown): value is { retained: Reading; importedAs?: string } =>
  !!value &&
  typeof value === 'object' &&
  'retained' in value &&
  isReading(value.retained) &&
  (!('importedAs' in value) || typeof value.importedAs === 'string');

const readStoredCopy = (key: string, value: unknown): RecoveryCopy | undefined => {
  let reading: Reading;
  let initialTarget: string | undefined;
  if (isRetainedRecoveryCopy(key) && isRetainedRecord(value)) {
    reading = value.retained;
    initialTarget = value.importedAs;
  } else if (isReading(value) && !isRetainedRecoveryCopy(key)) reading = value;
  else return;
  const assigned = localStorage.getItem(importReceipt(key)) ?? initialTarget;
  return assigned ? { key, reading, importedAs: assigned } : { key, reading };
};
export const isRecoveryStorageKey = (uid: string, key: string) => {
  const prefix = recoveryPrefix(uid);
  return key.startsWith(prefix) || key.startsWith(importReceipt(prefix));
};

// Each write gets its own key. An acknowledgment in one tab cannot erase another
// tab's newer reveal, even when both tabs are updating the same reading.
export const saveRecoveryCopy = (uid: string, reading: Reading): string => {
  try {
    const key = recoveryPrefix(uid) + crypto.randomUUID();
    const value = JSON.stringify(reading);
    localStorage.setItem(key, value);
    if (localStorage.getItem(key) === value) return key;
  } catch {
    // The owner can still recover the write in this tab after signing in again.
  }
  return saveTabRecoveryCopy(uid, reading);
};

export const hasRecoveryCopy = (key: string, reading: Reading, importedAs?: string): boolean => {
  if (isTabRecoveryKey(key)) return hasTabRecoveryCopy(key, reading, importedAs);
  try {
    const value = localStorage.getItem(key);
    if (isRetainedRecoveryCopy(key)) {
      const copy = readStoredCopy(key, JSON.parse(value ?? 'null'));
      return (
        !!copy &&
        JSON.stringify(copy.reading) === JSON.stringify(reading) &&
        copy.importedAs === importedAs
      );
    }
    return (
      value === JSON.stringify(reading) &&
      localStorage.getItem(importReceipt(key)) === (importedAs ?? null)
    );
  } catch {
    return false;
  }
};

export const loadRecoveryCopies = (uid: string) => {
  const copies: RecoveryCopy[] = loadTabRecoveryCopies(uid);
  const pendingCleanup: RecoveryCopy[] = [];
  const prepared: PreparedRecoveryCopy[] = loadPreparedTabRecovery(uid);
  let complete = true;
  const prefix = recoveryPrefix(uid);
  const unusedReceipts: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(importReceipt(prefix))) {
        try {
          if (localStorage.getItem(key.slice(importReceiptPrefix.length)) === null)
            unusedReceipts.push(key);
        } catch {
          // Retain the receipt when its reading cannot be checked.
        }
        continue;
      }
      if (!key?.startsWith(prefix)) continue;
      try {
        const value = localStorage.getItem(key);
        if (value === null) continue;
        const reading: unknown = JSON.parse(value);
        const copy = readStoredCopy(key, reading);
        if (copy) copies.push(copy);
        else if (isPendingCleanup(reading)) pendingCleanup.push({ key, reading: reading.discard });
        else if (isPrepared(reading))
          prepared.push({
            key,
            reading: reading.deleting,
            targetId: reading.targetId,
            importedAs: reading.importedAs,
          });
        else complete = false;
      } catch {
        complete = false;
      }
    }
  } catch {
    complete = false;
  }
  // Prune an interrupted cleanup after enumeration so indices cannot shift.
  for (const key of unusedReceipts) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* Contains only an opaque ID. */
    }
  }
  return { copies, pendingCleanup, prepared, complete };
};

const isPendingCleanup = (value: unknown): value is { discard: Reading } =>
  !!value && typeof value === 'object' && 'discard' in value && isReading(value.discard);

const isPrepared = (
  value: unknown,
): value is { deleting: Reading; targetId: string | null; importedAs?: string } =>
  !!value &&
  typeof value === 'object' &&
  'deleting' in value &&
  isReading(value.deleting) &&
  'targetId' in value &&
  (typeof value.targetId === 'string' || value.targetId === null) &&
  (!('importedAs' in value) || typeof value.importedAs === 'string');

const preparedRecord = (copy: PreparedRecoveryCopy) => ({
  deleting: copy.reading,
  targetId: copy.targetId,
  importedAs: copy.importedAs,
});

const writeRecoveryRecord = (key: string, record: unknown) => {
  const value = JSON.stringify(record);
  localStorage.setItem(key, value);
  if (localStorage.getItem(key) !== value) throw new Error('Recovery cleanup was not saved.');
};

// A later acknowledgment or a queued deletion may already hold the original
// key. Keep a separate copy before an unchecked restore can reach the server.
export const retainRecoveryCopies = (uid: string, copies: RecoveryCopy[]) =>
  copies.map((copy) => {
    const { key, reading, importedAs } = copy;
    if (isRetainedRecoveryCopy(key) && !('targetId' in copy)) {
      if (!hasRecoveryCopy(key, reading, importedAs))
        throw new Error(
          'The recovery copy changed or is unavailable. Review the current copy before importing.',
        );
      return copy;
    }
    const retained = key + retainedSuffix;
    try {
      if (isTabRecoveryKey(key)) saveTabRecoveryCopy(uid, reading, retained, importedAs);
      else if (localStorage.getItem(retained) === null)
        writeRecoveryRecord(retained, retainedRecord(copy));
      else if (!hasRecoveryCopy(retained, reading, importedAs)) throw new Error();
    } catch {
      throw new Error(
        'This browser could not keep a recovery copy before importing. Download your unsynced readings or restore browser storage and retry.',
      );
    }
    return { key: retained, reading, importedAs };
  });

// Save the assigned document ID before the transaction can commit. Treat it as
// a hint until the destination is read and its immutable contents match.
export const importTargetRecorder = (copies: RecoveryCopy[], source: Reading, required = false) => {
  // Firebase may retry with a different destination. Only the copies that
  // belonged to this source when the import began can follow those retries.
  const matching = copies.filter(
    (copy) =>
      (copy.importedAs ?? copy.reading.id) === source.id &&
      sameReadingContent(copy.reading, source),
  );
  const unavailable =
    'The retained recovery copy or its assigned ID could not be verified. Restore storage access and review the recovery copies again.';
  return async (id: string) => {
    if (required && !matching.length) throw new Error(unavailable);
    for (const copy of matching) {
      if ((copy.importedAs ?? copy.reading.id) === id) continue;
      if (!hasRecoveryCopy(copy.key, copy.reading, copy.importedAs)) {
        if (!required) continue;
        // A sibling may already have stored this exact assignment.
        if (!hasRecoveryCopy(copy.key, copy.reading, id)) throw new Error(unavailable);
        copy.importedAs = id;
        continue;
      }
      if (isTabRecoveryKey(copy.key)) setTabImportTarget(copy.key, id);
      else {
        // Write only the opaque receipt. A simultaneous discard or delete can
        // never be overwritten with the old reading by this transaction retry.
        const receipt = importReceipt(copy.key);
        try {
          if (localStorage.getItem(receipt) !== id) localStorage.setItem(receipt, id);
          if (localStorage.getItem(receipt) !== id) throw new Error();
        } catch {
          if (
            !required &&
            !isRetainedRecoveryCopy(copy.key) &&
            !copy.importedAs &&
            (await findImportTarget(source, [{ ...source, id }]))
          )
            continue;
          throw new Error(
            'Allow browser storage changes to save the assigned ID before importing this recovery copy.',
          );
        }
      }
      copy.importedAs = id;
    }
    // Check even an unchanged primary ID: the originally confirmed copy might
    // have become unreadable or been discarded while Firestore was resolving it.
    if (
      required &&
      matching.some((copy) => !hasRecoveryCopy(copy.key, copy.reading, copy.importedAs))
    )
      throw new Error(unavailable);
  };
};

// The intent and its original reading occupy one storage entry, so another tab
// or a restarted app can never see a half-written deletion marker.
const markForCleanup = (key: string) => {
  const raw = localStorage.getItem(key);
  if (raw === null) return;
  const reading: unknown = JSON.parse(raw);
  if (isPendingCleanup(reading)) return;
  const original = isPrepared(reading)
    ? reading.deleting
    : isRetainedRecord(reading)
      ? reading.retained
      : reading;
  if (!isReading(original)) throw new Error('Unreadable recovery copy.');
  writeRecoveryRecord(key, { discard: original });
};

export const removeRecoveryCopies = (keys: string[]) => {
  const removed = new Set<string>();
  const remaining = new Set<string>();
  for (const key of new Set(keys)) {
    if (isTabRecoveryKey(key)) {
      removeTabRecoveryCopy(key);
      removed.add(key);
      continue;
    }
    try {
      if (localStorage.getItem(key) === null) continue;
      // Keep the superseding marker until its original has been removed too.
      // Otherwise a partially denied discard could offer the stale source again.
      if (!recoveryKeysForCopy(key).some((source) => remaining.has(source)))
        localStorage.removeItem(key);
      if (localStorage.getItem(key) === null) {
        removed.add(key);
        // The main copy is already gone. An interrupted receipt cleanup is
        // retried by the next inventory scan.
        try {
          if (localStorage.getItem(importReceipt(key)) !== null)
            localStorage.removeItem(importReceipt(key));
        } catch {
          /* storage may have become read-only */
        }
      } else remaining.add(key);
    } catch {
      remaining.add(key);
    }
    if (remaining.has(key)) {
      try {
        markForCleanup(key);
      } catch {
        // Report the failed removal even if the store also refuses its marker.
      }
    }
  }
  return { removed, remaining };
};

// Mark or withdraw the exact keys before dispatching a destructive cloud
// operation. Preserve their contents for rollback if Firebase rejects it.
export const isPreparedCopy = (copy: PreparedRecoveryCopy) => {
  if (isTabRecoveryKey(copy.key)) return hasTabDeletionTarget(copy.key, copy.targetId);
  try {
    return localStorage.getItem(copy.key) === JSON.stringify(preparedRecord(copy));
  } catch {
    return false;
  }
};

const restorePreparedCopy = (copy: PreparedRecoveryCopy) => {
  if (!isPreparedCopy(copy)) return;
  if (isTabRecoveryKey(copy.key)) setTabDeletionTarget(copy.key, undefined);
  else
    writeRecoveryRecord(
      copy.key,
      isRetainedRecoveryCopy(copy.key) ? retainedRecord(copy) : copy.reading,
    );
};

export const prepareRecoveryDeletion = (copies: PreparedRecoveryCopy[]) => {
  const changed: PreparedRecoveryCopy[] = [];
  const restore = () => {
    for (const copy of changed) {
      try {
        restorePreparedCopy(copy);
      } catch {
        // The durable marker still holds the original for reconciliation on retry.
      }
    }
  };
  for (const copy of copies) {
    try {
      if (isPreparedCopy(copy)) continue;
      if (!isTabRecoveryKey(copy.key)) {
        const value = localStorage.getItem(copy.key);
        if (value === null || isPendingCleanup(JSON.parse(value))) continue;
      }
      if (!hasRecoveryCopy(copy.key, copy.reading, copy.importedAs))
        throw new Error('The recovery copy changed.');
      if (isTabRecoveryKey(copy.key)) setTabDeletionTarget(copy.key, copy.targetId);
      else writeRecoveryRecord(copy.key, preparedRecord(copy));
      changed.push(copy);
    } catch {
      restore();
      throw new Error(
        'Deletion could not start. Allow browser storage changes, then choose the readings and confirm again.',
      );
    }
  }
  return restore;
};

// Match a recovery copy to the same document the import resolver selects.
// Identical spread contents alone are insufficient: two different IDs may
// legitimately contain the same reading.
export const recoveryReadingLookup = (
  entries: Reading[],
  lookupMissing?: (id: string) => Promise<Reading | undefined>,
) => {
  const known = new Map(entries.map((entry) => [entry.id, entry]));
  const outsidePage = new Map<string, Promise<Reading | undefined>>();
  return (id: string) => {
    const reading = known.get(id);
    if (reading || !lookupMissing) return reading;
    const result = outsidePage.get(id) ?? lookupMissing(id);
    outsidePage.set(id, result);
    return result;
  };
};

export const resolvedRecoveryCopies = async (
  copies: RecoveryCopy[],
  entries: Reading[],
  targets: Reading[],
  requireAllReveals: boolean,
  lookupMissing?: (id: string) => Promise<Reading | undefined>,
): Promise<RecoveryCopy[]> => {
  const lookup = recoveryReadingLookup(entries, lookupMissing);
  const uncertain = new Set<string>();
  const matches = await Promise.all(
    copies.map(async (copy) => {
      const candidates = targets.filter(
        (target) =>
          sameReadingContent(target, copy.reading) &&
          (!requireAllReveals ||
            copy.reading.revealed.every((shown, i) => !shown || target.revealed[i])),
      );
      if (!candidates.length) return false;
      // A removed or replaced destination cannot acknowledge this copy through
      // a different document, even if its original ID still has the same spread.
      if (copy.importedAs) return candidates.some((entry) => entry.id === copy.importedAs);
      if (candidates.some((entry) => entry.id === copy.reading.id)) return true;
      if (!candidates.some((entry) => entry.id.startsWith('import-'))) return false;
      const match = await resolveImportReading(copy.reading, lookup);
      if (match.existing) return candidates.some((entry) => entry.id === match.id);
      // Older releases stored only a hash and lost the attempt number. Recover
      // legacy targets beyond a vacancy by checking the original hash itself.
      // Keep any unproven copy instead of discarding another reading's data.
      if (await findImportTarget(copy.reading, candidates)) return true;
      for (const candidate of candidates) {
        if (/^import-[\da-f]{64}$/.test(candidate.id)) uncertain.add(candidate.id);
      }
      return false;
    }),
  );
  // A legacy opaque ID without a receipt may be beyond the recoverable hash
  // range. Avoid deleting the target and silently offering the stale copy again.
  if (!requireAllReveals && !matches.some(Boolean) && uncertain.size)
    throw new Error(unverifiedImportMessage);
  return copies.filter((_, index) => matches[index]);
};

export const combineReadingCopies = (
  copies: Pick<RecoveryCopy, 'reading' | 'importedAs'>[],
): Reading[] => {
  const byId = new Map<string, Reading[]>();
  for (const copy of copies) {
    // Restore at the last assigned ID. Import checks immutable content before
    // merging reveals, even if that destination has since been replaced.
    const reading = copy.importedAs ? assignReadingId(copy.reading, copy.importedAs) : copy.reading;
    const variants = byId.get(reading.id) ?? [];
    const match = variants.findIndex((previous) => sameReadingContent(previous, reading));
    if (match < 0) variants.push(reading);
    else variants[match] = mergeReveals(variants[match], reading);
    byId.set(reading.id, variants);
  }
  return Array.from(byId.values()).flat();
};

export const containsRecoveryCopy = (saved: RecoveryCopy, reading: Reading) =>
  !saved.importedAs &&
  saved.reading.id === reading.id &&
  sameReadingContent(saved.reading, reading) &&
  reading.revealed.every((shown, i) => !shown || saved.reading.revealed[i]);
