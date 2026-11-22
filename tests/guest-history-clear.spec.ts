import { expect, test, type Page } from '@playwright/test';

const journalKey = 'stilllight.tarot.v1';
const recoveryKey = journalKey + '.recovery';
const accountKey = 'arcana.journal.recovery.v1:another-account:its-reading';
const unrelatedKey = recoveryKey + '.preferences';

const seedCopies = (page: Page) =>
  page.evaluate(
    ({ recoveryKey, accountKey, unrelatedKey }) => {
      localStorage.setItem(recoveryKey, 'private guest question');
      localStorage.setItem(recoveryKey + '.1', 'second private question');
      localStorage.setItem(recoveryKey + '.14', 'older private question');
      localStorage.setItem(accountKey, 'private account reading');
      localStorage.setItem(unrelatedKey, 'keep this preference');
    },
    { recoveryKey, accountKey, unrelatedKey },
  );

const clearHistory = async (page: Page, confirm: boolean) => {
  await page.getByRole('button', { name: 'Clear History' }).click();
  const dialog = page.getByRole('dialog', { name: 'Clear your journal?' });
  await expect(dialog).toContainText('guest recovery copies');
  await dialog
    .getByRole('button', { name: confirm ? 'Clear All Readings' : 'Keep Readings' })
    .click();
};

test('guest clear erases recovery copies after confirmation and keeps unrelated data after reload', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel(/What’s on your mind/).fill('Private visible question');
  await page.getByRole('button', { name: /Draw Cards/ }).click();
  await page.getByRole('link', { name: /^Journal/ }).click();
  await seedCopies(page);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export journal', exact: true }).click();
  await downloaded;
  const previousBackup = page.getByRole('link', { name: 'Download backup' });
  const oldUrl = await previousBackup.getAttribute('href');
  expect(oldUrl).toBeTruthy();
  const before = await page.evaluate(() => ({ ...localStorage }));
  await clearHistory(page, false);
  await expect(previousBackup).toBeVisible();
  expect(await page.evaluate(() => ({ ...localStorage }))).toEqual(before);
  await expect(page.getByRole('heading', { name: 'Private visible question' })).toBeVisible();
  await clearHistory(page, true);
  await expect(
    page.getByText('Guest history and its recovery copies were cleared from this device.'),
  ).toBeVisible();
  await expect(previousBackup).toHaveCount(0);
  expect(
    await page.evaluate(async (url) => {
      try {
        await fetch(url);
        return true;
      } catch {
        return false;
      }
    }, oldUrl!),
  ).toBe(false);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'A fresh page awaits.' })).toBeVisible();
  const after = await page.evaluate(() => ({ ...localStorage }));
  expect(after[accountKey]).toBe(before[accountKey]);
  expect(after[unrelatedKey]).toBe(before[unrelatedKey]);
  expect(JSON.parse(after[journalKey]).readings).toEqual([]);
  expect([after[recoveryKey], after[recoveryKey + '.1'], after[recoveryKey + '.14']]).toEqual([
    undefined,
    undefined,
    undefined,
  ]);
});

test('clearing in one guest tab removes the private reading and backup from open siblings', async ({
  page,
  context,
}) => {
  await page.goto('/');
  const question = 'Private question shared across these tabs';
  await page.getByLabel(/What’s on your mind/).fill(question);
  await page.getByRole('button', { name: /Draw Cards/ }).click();
  await page.getByRole('link', { name: /^Journal/ }).click();
  const reader = await context.newPage();
  await reader.goto('/');
  await expect(reader.getByText(question, { exact: true })).toBeVisible();
  const exporter = await context.newPage();
  await exporter.goto('/journal');
  await expect(exporter.getByRole('heading', { name: question })).toBeVisible();
  const downloaded = exporter.waitForEvent('download');
  await exporter.getByRole('button', { name: 'Export journal' }).click();
  await downloaded;
  const backup = exporter.getByRole('link', { name: 'Download backup' });
  await expect(backup).toBeVisible();
  await clearHistory(page, true);
  await expect(reader.getByText(question, { exact: true })).toHaveCount(0);
  await expect(reader.getByRole('button', { name: 'Copy Reading' })).toHaveCount(0);
  await expect(exporter.getByRole('heading', { name: 'A fresh page awaits.' })).toBeVisible();
  await expect(backup).toHaveCount(0);
});

test('a guest tab can export its unsaved reveal after a sibling clears the saved journal', async ({
  page,
  context,
}) => {
  await page.goto('/');
  const question = 'Only this tab has the unsaved reveal';
  await page.getByLabel(/What’s on your mind/).fill(question);
  await page.getByRole('button', { name: /Draw Cards/ }).click();
  await page.getByRole('link', { name: /^Journal/ }).click();
  const draft = await context.newPage();
  await draft.goto('/');
  await draft.evaluate((key) => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Read-only guest journal', 'SecurityError');
      write.call(this, name, value);
    };
  }, journalKey);
  await draft.getByRole('button', { name: 'Reveal card 1' }).click();
  await expect(draft.getByText(/could not save your reading or settings/)).toBeVisible();
  await draft.getByRole('link', { name: /^Journal/ }).click();
  await clearHistory(page, true);
  await expect(
    draft.getByText(/saved guest journal changed while this tab had unsaved readings/),
  ).toBeVisible();
  const downloaded = draft.waitForEvent('download');
  await draft.getByRole('button', { name: 'Export journal' }).click();
  await downloaded;
  const backup = await draft
    .getByRole('link', { name: 'Download backup' })
    .evaluate(async (link) => (await fetch((link as HTMLAnchorElement).href)).json());
  expect(backup.readings).toEqual([
    expect.objectContaining({ question, revealed: [true, false, false] }),
  ]);
  expect(
    await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).readings, journalKey),
  ).toEqual([]);
});

test('an empty guest journal reports partial recovery removal and supports retry after reopening', async ({
  page,
}) => {
  await page.goto('/journal');
  await expect(page.getByRole('heading', { name: 'A fresh page awaits.' })).toBeVisible();
  await seedCopies(page);
  await page.evaluate((blocked) => {
    const remove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key) {
      if (key === blocked) throw new DOMException('Storage denied', 'SecurityError');
      remove.call(this, key);
    };
  }, recoveryKey + '.1');
  await clearHistory(page, true);
  await expect(page.getByRole('alert')).toContainText(
    'Some guest recovery copies may still be on this device',
  );
  expect(await page.evaluate((key) => localStorage.getItem(key), recoveryKey + '.1')).toBe(
    'second private question',
  );
  expect(await page.evaluate((key) => localStorage.getItem(key), recoveryKey + '.14')).toBeNull();
  await page.reload();
  await clearHistory(page, true);
  await expect(
    page.getByText('Guest history and its recovery copies were cleared from this device.'),
  ).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), recoveryKey + '.1')).toBeNull();
  expect(await page.evaluate((key) => localStorage.getItem(key), accountKey)).toBe(
    'private account reading',
  );
});
