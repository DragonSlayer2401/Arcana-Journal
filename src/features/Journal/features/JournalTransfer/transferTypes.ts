import type { WatchExportHistory } from '@/services/Journal/journal.service';

export interface JournalExport {
  json: string;
  scope: 'journal' | 'cloud-and-tab' | 'unchecked-deletions';
  watchHistory?: WatchExportHistory;
}
