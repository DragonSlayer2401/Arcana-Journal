import { freshData, readSettings, type AppData } from '@/features/Journal/utils/journalData';
import { isReading } from '@/features/Journal/utils/readingValidation';
import { guestStorageKey } from './guestStorageKey';

export { guestStorageKey };
export const guestRecoveryKey = guestStorageKey + '.recovery';

const parseSavedData = (raw: string): AppData => {
  const parsed = JSON.parse(raw) as AppData;
  const settings = readSettings(parsed.settings);
  if (
    parsed.version !== 1 ||
    !Array.isArray(parsed.readings) ||
    !parsed.readings.every(isReading) ||
    new Set(parsed.readings.map((r) => r.id)).size !== parsed.readings.length ||
    !settings ||
    typeof parsed.awaitingNewReading !== 'boolean' ||
    !(parsed.activeId === null || parsed.readings.some((r) => r.id === parsed.activeId))
  ) {
    throw new Error('Invalid saved data');
  }
  return { ...parsed, settings };
};

// Most writes follow a successful read or write in this tab. Recheck the shape
// when another tab (including a newer app version) has replaced the value.
let lastValidRaw: string | null = null;
export const guestSaveWarning =
  'This device could not save your reading or settings. Your cards are still available in this session. Open Journal and choose Export journal before leaving.';
export const loadData = (
  fallback?: AppData,
): { data: AppData; warning: string; storageUnavailable?: boolean } => {
  let raw: string | null | undefined;
  try {
    raw = localStorage.getItem(guestStorageKey);
    if (raw === null) return { data: freshData(), warning: '' };
    const data = parseSavedData(raw);
    lastValidRaw = raw;
    return { data, warning: '' };
  } catch {
    return {
      data: fallback ?? freshData(),
      storageUnavailable: raw === undefined,
      warning:
        'Saved data could not be read. You can still draw here. If you have a journal backup, you can import it in another browser.',
    };
  }
};
const writeGuestData = (raw: string) => {
  localStorage.setItem(guestStorageKey, raw);
  lastValidRaw = raw;
};

// The caller holds the guest write lock. A confirmed clear must never archive
// the old journal again, including when its saved format cannot be read.
export const clearGuestHistory = (remaining: AppData) => {
  try {
    const saved = localStorage.getItem(guestStorageKey);
    const raw = JSON.stringify(remaining);
    // A journal containing only recovery copies needs no new storage space to clear.
    if ((saved ?? JSON.stringify(freshData())) !== raw) writeGuestData(raw);
  } catch {
    return 'journal-write-failed';
  }
  try {
    // Collect first: removing a key shifts the remaining localStorage indices.
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (
        key === guestRecoveryKey ||
        (key?.startsWith(guestRecoveryKey + '.') &&
          /^\d+$/.test(key.slice(guestRecoveryKey.length + 1)))
      )
        keys.push(key);
    }
    let complete = true;
    for (const key of keys) {
      try {
        localStorage.removeItem(key);
        if (localStorage.getItem(key) !== null) complete = false;
      } catch {
        complete = false;
      }
    }
    return complete ? 'cleared' : 'recovery-incomplete';
  } catch {
    return 'recovery-incomplete';
  }
};

export const saveData = (data: AppData): string => {
  try {
    const existing = localStorage.getItem(guestStorageKey);
    if (existing !== null && existing !== lastValidRaw) {
      try {
        parseSavedData(existing);
      } catch {
        // Save the exact unreadable source before persisting this session's new
        // journal. A full/disabled store throws here, leaving the source intact.
        let key = guestRecoveryKey;
        for (let copy = 1; ; copy++) {
          const previous = localStorage.getItem(key);
          if (previous === existing) break;
          if (previous === null) {
            localStorage.setItem(key, existing);
            break;
          }
          key = guestRecoveryKey + '.' + copy;
        }
      }
    }
    writeGuestData(JSON.stringify(data));
    return '';
  } catch {
    return guestSaveWarning;
  }
};
