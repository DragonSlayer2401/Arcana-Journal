import type { AppData } from '@/features/Journal/utils/journalData';
import type { loadData } from './guestStorage';

export interface GuestDraft {
  data: AppData;
  base: AppData;
}
export const guestConflictMessage =
  'The saved guest journal changed while this tab had unsaved readings. Export your backup, then reload and import it to merge the readings.';
export const guestDraftConflicts = (
  draft: GuestDraft | null,
  stored: ReturnType<typeof loadData>,
) => draft && !stored.warning && JSON.stringify(draft.base) !== JSON.stringify(stored.data);
