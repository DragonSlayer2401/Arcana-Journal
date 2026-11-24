import { useJournalSession } from '@/features/Journal/hooks/useJournalSession';
import {
  createJournalBackup,
  mergeJournalReadings,
  parseJournalBackup,
} from '@/features/Journal/utils/journalBackup';
import type { Reading } from '@/features/Journal/readingTypes';
import {
  guestDraftConflicts,
  guestConflictMessage,
} from '@/features/Journal/features/GuestJournal/utils/guestDraft';
import { loadData, saveData } from '@/features/Journal/features/GuestJournal/utils/guestStorage';
import { withGuestWrite } from '@/features/Journal/features/GuestJournal/utils/guestWrite';
import type { RecoveryCopy } from '@/features/Journal/features/AccountJournal/utils/readingRecovery';
import { checkSiblingRecovery } from '@/services/Journal/journalActivity';
import {
  exportAccountJournal,
  checkReadingsForPendingDeletions,
  previewAccountImport,
  importAccountReadings,
  type WatchExportHistory,
} from '@/services/Journal/journal.service';
import type { JournalExport } from '../transferTypes';
import { useDeviceJournalImport } from './useDeviceJournalImport';

export const useJournalTransfer = () => {
  const { account, user, journalUid, historyRevision, getGuestDraft, updateGuestReadings } =
    useJournalSession();
  const deviceImport = useDeviceJournalImport();
  const exportJournal = async (allowUncheckedDeletions = false): Promise<JournalExport> => {
    if (journalUid) {
      const checkOtherTabs = async () => {
        const status = await checkSiblingRecovery(journalUid);
        if (status === 'busy')
          throw new Error(
            'Another tab has unsynced journal changes. Sync or recover those readings in that tab, then export again.',
          );
      };
      await checkOtherTabs();
      let watchHistory: WatchExportHistory | undefined;
      let json = await exportAccountJournal(journalUid, allowUncheckedDeletions, (watch) => {
        watchHistory = watch;
      });
      const cloudReadings = parseJournalBackup(json);
      const recovery = account.getRecoveryForExport();
      if (!recovery.complete)
        throw new Error(
          'A complete backup needs access to every recovery copy. Allow browser storage and export again.',
        );
      if (recovery.readings.length) {
        const { readings } = await mergeJournalReadings(
          cloudReadings,
          recovery.readings,
          recovery.assignedIds,
        );
        await checkReadingsForPendingDeletions(
          journalUid,
          readings.map(({ id }) => id),
          allowUncheckedDeletions,
        );
        json = await createJournalBackup(() => ({ readings, nextCursor: null }));
      }
      await checkOtherTabs();
      // An isolated or suspended tab may be unable to advertise memory-only readings.
      return {
        json,
        scope: allowUncheckedDeletions ? 'unchecked-deletions' : 'cloud-and-tab',
        watchHistory,
      };
    }
    const json = await createJournalBackup(async () => ({
      readings: await deviceImport.getDeviceReadings(),
      nextCursor: null,
    }));
    return { json, scope: 'journal' };
  };
  const deviceJournal = () => {
    const draft = getGuestDraft();
    if (draft && guestDraftConflicts(draft, loadData())) throw new Error(guestConflictMessage);
    if (draft) return draft.data;
    const { data: device, warning: readWarning } = loadData();
    if (readWarning) {
      throw new Error(
        'The saved journal could not be read to merge this backup. You can restore the file in another browser.',
      );
    }
    return device;
  };
  const previewImport = (
    incoming: Reading[],
    onProgress?: (done: number, total: number) => void,
  ) =>
    journalUid
      ? previewAccountImport(journalUid, incoming, onProgress)
      : mergeJournalReadings(deviceJournal().readings, incoming);
  const importJournal = async (
    incoming: Reading[],
    onProgress?: (done: number, total: number) => void,
    allowUncheckedDeletions = false,
    retainedCopies?: RecoveryCopy[],
    recovering = false,
  ) => {
    if (journalUid)
      return importAccountReadings(
        journalUid,
        incoming,
        onProgress,
        allowUncheckedDeletions,
        retainedCopies,
        recovering,
      );
    // Hash older IDs outside the storage transaction. Retry the merge if a
    // sibling changed the guest journal before the final synchronous save.
    for (;;) {
      const current = deviceJournal();
      const result = await mergeJournalReadings(current.readings, incoming);
      const saved = await withGuestWrite(() => {
        if (JSON.stringify(deviceJournal()) !== JSON.stringify(current)) return false;
        const next = { ...current, readings: result.readings };
        const changed = Boolean(result.added || result.updated || getGuestDraft());
        if (changed && saveData(next))
          throw new Error(
            'This device could not save the imported readings. Keep your backup and try again.',
          );
        updateGuestReadings(next.readings, changed);
        return true;
      });
      if (saved) return result;
    }
  };

  if (user === undefined) return null;
  return {
    historyRevision,
    accountEmail: journalUid ? (user?.email ?? null) : null,
    recoveryReadings: account.recoveryReadings,
    deletionStorageUnreadable: account.deletionStorageUnreadable,
    recoveryComplete: account.recoveryComplete,
    getRecoveryForExport: account.getRecoveryForExport,
    savedRecovery: account.savedRecovery,
    ...deviceImport,
    onExport: exportJournal,
    onPreview: previewImport,
    onImport: importJournal,
  };
};
