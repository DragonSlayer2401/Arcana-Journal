import { readFile } from 'node:fs/promises';
import { expect, test, type FileChooser, type Page } from '@playwright/test';
import type { AppData } from '../src/domain/storage';

const savedJournal = (page: Page): Promise<AppData> =>
  page.evaluate(() => JSON.parse(localStorage.getItem('stilllight.tarot.v1')!));

const importFile = async (page: Page, file: Parameters<FileChooser['setFiles']>[0]) => {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import journal', exact: true }).click();
  await (await chooser).setFiles(file);
};

test('a guest can export the whole journal offline and restore a partially revealed spread', async ({
  page,
  context,
}, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Ready for offline use' })).toBeVisible();
  const journalTab = await context.newPage();
  await journalTab.goto('/journal');
  await expect(journalTab.getByRole('heading', { name: 'A fresh page awaits.' })).toBeVisible();
  await context.setOffline(true);
  await page.getByLabel(/What’s on your mind/).fill('A quiet morning');
  await page.getByRole('button', { name: /Draw Cards/ }).click();
  await page.getByRole('button', { name: 'Reveal card 2', exact: true }).click();
  await page.getByRole('button', { name: 'New Reading' }).click();
  await page.getByRole('button', { name: /One card/ }).click();
  await page.getByRole('button', { name: /Draw Cards/ }).click();
  const original = await savedJournal(page);
  expect(original.readings).toHaveLength(2);
  expect(original.readings[1].revealed).toEqual([false, true, false]);

  const downloading = journalTab.waitForEvent('download');
  await journalTab.getByRole('button', { name: 'Export journal', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/\.json$/i);
  const backup = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(backup);
  expect(JSON.parse(await readFile(backup, 'utf8'))).toEqual({
    version: 1,
    readings: original.readings,
  });

  await page.getByRole('link', { name: /^Journal/ }).click();
  await page.getByRole('button', { name: 'Clear History' }).click();
  await page.getByRole('button', { name: 'Clear All Readings' }).click();
  await expect(page.getByRole('heading', { name: 'A fresh page awaits.' })).toBeVisible();
  await importFile(page, backup);
  await page.getByRole('button', { name: 'Confirm import' }).click();
  await expect(page.getByRole('button', { name: /^Open reading:/ })).toHaveCount(2);
  await importFile(page, backup);
  await page.getByRole('button', { name: 'Confirm import' }).click();
  await expect(page.getByRole('status')).toContainText(/skipped 2/i);
  await page.reload();
  const restored = await savedJournal(page);
  expect(restored.readings).toEqual(original.readings);
  expect(restored.settings).toEqual(original.settings);
  await page.getByRole('button', { name: /^Open reading: A quiet morning/ }).click();
  await expect(page.getByRole('button', { name: 'Reveal card 1', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /View card details/ })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Reveal card 3', exact: true })).toBeVisible();
});

test('a rejected file leaves the journal intact and a corrected file merges with the active reading', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel(/What’s on your mind/).fill('A reading already on this device');
  await page.getByRole('button', { name: /Draw Cards/ }).click();
  const existing = await savedJournal(page);
  await page.getByRole('link', { name: /^Journal/ }).click();

  const imported = {
    id: 'all',
    createdAt: '2021-03-14T01:30:00-06:00',
    question: 'What was on my mind then?',
    cards: [
      { cardId: 'major-02', orientation: 'reversed' },
      { cardId: 'major-01', orientation: 'upright' },
    ],
    revealed: [true, false],
  };
  const upload = (readings: unknown[]) =>
    importFile(page, {
      name: 'journal.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ version: 1, readings })),
    });

  await upload([imported, { ...imported, id: 'invalid-reading', revealed: [] }]);
  await expect(page.getByRole('alert')).toBeVisible();
  expect(await savedJournal(page)).toEqual(existing);
  await expect(page.getByRole('button', { name: /^Open reading:/ })).toHaveCount(1);

  await upload([imported, { ...existing.readings[0], question: 'Older copy of this question' }]);
  await page.getByRole('button', { name: 'Confirm import' }).click();
  await expect(page.getByRole('button', { name: /^Open reading:/ })).toHaveCount(3);
  const withCollision = await savedJournal(page);
  const olderCopy = withCollision.readings.find(
    ({ question }) => question === 'Older copy of this question',
  );
  expect(olderCopy?.id).toMatch(/^import-/);
  expect(withCollision.readings).toEqual(expect.arrayContaining([existing.readings[0], imported]));
  await page.getByRole('link', { name: 'Reading', exact: true }).click();
  await expect(page.getByText(existing.readings[0].question, { exact: true })).toBeVisible();
  await page.getByRole('link', { name: /^Journal/ }).click();
  await page.getByRole('button', { name: 'Delete reading: What was on my mind then?' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Delete Reading', exact: true })
    .click();
  expect((await savedJournal(page)).readings).toEqual(
    expect.arrayContaining([existing.readings[0], olderCopy]),
  );
});

test('a failed storage write leaves both journals intact and the same backup can be retried', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Draw Cards/ }).click();
  const existing = await savedJournal(page);
  const incoming = { ...existing.readings[0], id: 'from-another-device', question: 'A new idea' };
  const backup = {
    name: 'saved-readings.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ version: 1, readings: [incoming] })),
  };
  await page.getByRole('link', { name: /^Journal/ }).click();
  await page.evaluate(() => {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'stilllight.tarot.v1') {
        Storage.prototype.setItem = originalSetItem;
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      }
      return originalSetItem.call(this, key, value);
    };
  });
  await importFile(page, backup);
  await page.getByRole('button', { name: 'Confirm import' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Open reading:/ })).toHaveCount(1);
  expect(await savedJournal(page)).toEqual(existing);

  await page.getByRole('button', { name: 'Confirm import' }).click();
  await expect(page.getByRole('button', { name: /^Open reading: A new idea/ })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  const recovered = await savedJournal(page);
  expect(recovered.readings).toHaveLength(2);
  expect(recovered.readings).toEqual(expect.arrayContaining([existing.readings[0], incoming]));
  expect(recovered.activeId).toBe(existing.activeId);
});
