import type { Reading } from '@/features/Journal/readingTypes';
import { holdRecoveryActivity } from '@/services/Journal/journalActivity';

// A Firebase sign-out in another tab can unmount the journal. Keep the last
// copy with its original account for as long as this window remains open.
const copies = new Map<
  string,
  { uid: string; value: string; targetId?: string | null; importedAs?: string; release: () => void }
>();
const prefix = 'arcana-tab-recovery:';
let sequence = 0;
export const tabRecoveryEvent = (uid: string) => 'arcana-tab-recovery-change:' + uid;

const warnBeforeClose = (event: BeforeUnloadEvent) => {
  event.preventDefault();
  event.returnValue = true;
};

export const saveTabRecoveryCopy = (
  uid: string,
  reading: Reading,
  key = prefix + ++sequence,
  importedAs?: string,
): string => {
  if (copies.has(key)) {
    if (hasTabRecoveryCopy(key, reading, importedAs)) return key;
    throw new Error('The recovery copy changed.');
  }
  if (!copies.size) window.addEventListener('beforeunload', warnBeforeClose);
  copies.set(key, {
    uid,
    value: JSON.stringify(reading),
    importedAs,
    release: holdRecoveryActivity(uid),
  });
  window.dispatchEvent(new Event(tabRecoveryEvent(uid)));
  return key;
};

export const isTabRecoveryKey = (key: string) => key.startsWith(prefix);

export const hasTabRecoveryCopy = (key: string, reading: Reading, importedAs?: string) => {
  const copy = copies.get(key);
  return (
    !!copy &&
    copy.targetId === undefined &&
    copy.value === JSON.stringify(reading) &&
    copy.importedAs === importedAs
  );
};

export const hasTabRecoveryCopies = (uid: string) =>
  Array.from(copies.values()).some((copy) => copy.uid === uid);

export const loadTabRecoveryCopies = (uid: string) =>
  Array.from(copies).flatMap(([key, copy]) =>
    copy.uid === uid && copy.targetId === undefined
      ? [{ key, reading: JSON.parse(copy.value) as Reading, importedAs: copy.importedAs }]
      : [],
  );

export const loadPreparedTabRecovery = (uid: string) =>
  Array.from(copies).flatMap(([key, copy]) =>
    copy.uid === uid && copy.targetId !== undefined
      ? [
          {
            key,
            reading: JSON.parse(copy.value) as Reading,
            targetId: copy.targetId,
            importedAs: copy.importedAs,
          },
        ]
      : [],
  );

export const setTabDeletionTarget = (key: string, targetId: string | null | undefined) => {
  const copy = copies.get(key);
  if (!copy) return;
  copy.targetId = targetId;
  window.dispatchEvent(new Event(tabRecoveryEvent(copy.uid)));
};

export const hasTabDeletionTarget = (key: string, targetId: string | null) =>
  copies.get(key)?.targetId === targetId;

export const setTabImportTarget = (key: string, id: string) => {
  const copy = copies.get(key);
  if (copy && copy.targetId === undefined && copy.importedAs !== id) {
    copy.importedAs = id;
    window.dispatchEvent(new Event(tabRecoveryEvent(copy.uid)));
  }
};

export const removeTabRecoveryCopy = (key: string) => {
  const copy = copies.get(key);
  if (!copy) return;
  copies.delete(key);
  copy.release();
  if (!copies.size) window.removeEventListener('beforeunload', warnBeforeClose);
  window.dispatchEvent(new Event(tabRecoveryEvent(copy.uid)));
};
