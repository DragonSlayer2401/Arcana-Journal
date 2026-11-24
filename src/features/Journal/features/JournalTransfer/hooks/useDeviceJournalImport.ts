import { useCallback, useEffect, useState } from 'react';
import { useJournalSession } from '@/features/Journal/hooks/useJournalSession';
import type { Reading } from '@/features/Journal/readingTypes';
import { mergeJournalReadings } from '@/features/Journal/utils/journalBackup';
import { readingEpoch } from '@/features/Journal/utils/readingDate';
import { observeReadingsOnDates } from '@/services/Journal/journal.service';
import { guestDraftConflicts } from '../../GuestJournal/utils/guestDraft';
import { recoverGuestReadings } from '../../GuestJournal/utils/guestRecovery';
import { guestStorageKey, loadData } from '../../GuestJournal/utils/guestStorage';
import { waitForGuestWrites } from '../../GuestJournal/utils/guestWrite';

const datesPerQuery = 30;

export const useDeviceJournalImport = () => {
  const { journalUid, account, getGuestDraft } = useJournalSession();
  const { storedReadings, hasMore, loading } = account;
  const [device, setDevice] = useState<{
    readings: Reading[] | null;
    unsaved: boolean;
  } | null>(null);
  const [deviceCount, setDeviceCount] = useState(0);

  const getDeviceReadings = useCallback(async () => {
    await waitForGuestWrites();
    const draft = getGuestDraft();
    const stored = loadData();
    if (draft)
      return guestDraftConflicts(draft, stored)
        ? recoverGuestReadings(draft.base.readings, draft.data.readings, stored.data.readings)
        : draft.data.readings;
    if (stored.warning) throw new Error('The saved journal could not be read to create a backup.');
    return stored.data.readings;
  }, [getGuestDraft]);

  useEffect(() => {
    if (!journalUid) return;
    let revision = 0;
    const refresh = async () => {
      const current = ++revision;
      const readings = await getDeviceReadings().catch(() => null);
      if (current === revision) setDevice({ readings, unsaved: Boolean(getGuestDraft()) });
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === guestStorageKey) void refresh();
    };
    void refresh();
    window.addEventListener('storage', onStorage);
    window.addEventListener('pageshow', refresh);
    return () => {
      revision++;
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('pageshow', refresh);
    };
  }, [journalUid, getGuestDraft, getDeviceReadings]);

  useEffect(() => {
    if (!journalUid || !device || loading) return;
    const guest = device.readings;
    if (!guest?.length || !storedReadings) {
      setDeviceCount(guest?.length ?? 0);
      return;
    }

    // All possible copies of a draw have the same creation time, even when an
    // earlier import assigned it a new ID. Watch older dates outside the page.
    const oldest = storedReadings.at(-1);
    const cutoff = oldest ? readingEpoch(oldest.createdAt) : Infinity;
    const olderDates = hasMore
      ? [...new Set(guest.map((reading) => readingEpoch(reading.createdAt)))].filter(
          (date) => date <= cutoff,
        )
      : [];
    const groups = new Map<number, Reading[]>();
    const stops: (() => void)[] = [];
    let revision = 0;
    const compare = async () => {
      if (groups.size < Math.ceil(olderDates.length / datesPerQuery)) return;
      const current = ++revision;
      const candidates = storedReadings.concat(...groups.values());
      try {
        const { added, updated } = await mergeJournalReadings(candidates, guest);
        if (current === revision) setDeviceCount(added + updated);
      } catch {
        // Ambiguous legacy IDs still need the full import review.
        if (current === revision) setDeviceCount(guest.length);
      }
    };
    for (let index = 0; index < olderDates.length; index += datesPerQuery) {
      const update = (readings: Reading[]) => {
        groups.set(index, readings);
        void compare();
      };
      stops.push(
        observeReadingsOnDates(
          journalUid,
          olderDates.slice(index, index + datesPerQuery),
          update,
          () => update([]),
        ),
      );
    }
    if (!olderDates.length) void compare();
    return () => {
      revision++;
      stops.forEach((stop) => stop());
    };
  }, [journalUid, device, loading, storedReadings, hasMore]);

  return { deviceCount, unsavedGuestChanges: device?.unsaved ?? false, getDeviceReadings };
};
