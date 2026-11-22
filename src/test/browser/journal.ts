import { type FileChooser, type Page } from '@playwright/test';
import type { AppData } from '@/features/Journal/utils/journalData';

export const savedJournal = (page: Page): Promise<AppData> =>
  page.evaluate(() => JSON.parse(localStorage.getItem('stilllight.tarot.v1')!));

export const importFile = async (page: Page, file: Parameters<FileChooser['setFiles']>[0]) => {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import journal', exact: true }).click();
  await (await chooser).setFiles(file);
};
