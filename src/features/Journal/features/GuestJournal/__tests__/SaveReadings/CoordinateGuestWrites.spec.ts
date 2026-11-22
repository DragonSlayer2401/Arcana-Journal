import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { AppData } from '@/features/Journal/utils/journalData';

const questions = (page: Page) =>
  page.evaluate(() => {
    const data: AppData | null = JSON.parse(localStorage.getItem('stilllight.tarot.v1') ?? 'null');
    return data?.readings.map((reading) => reading.question) ?? [];
  });

const warnsBeforeClose = (page: Page) =>
  page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })));

const guestBackup = async (page: Page): Promise<Pick<AppData, 'readings'>> => {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export journal', exact: true }).click();
  const file = await download;
  return JSON.parse(await readFile((await file.path())!, 'utf8'));
};

test('a guest draw remains in its backup after storage access returns', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await page.getByLabel(/What’s on your mind/).fill('Draw saved only in this tab');
  const restore = await page.evaluateHandle(() => {
    const get = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (key === 'stilllight.tarot.v1')
        throw new DOMException('Storage unavailable', 'SecurityError');
      return get.call(this, key);
    };
    return () => {
      Storage.prototype.getItem = get;
    };
  });
  await page.getByRole('button', { name: /Draw Cards/ }).click();
  await expect(page.getByRole('button', { name: 'Reveal card 1', exact: true })).toBeVisible();
  await page.getByRole('link', { name: /^Journal/ }).click();
  const before = await guestBackup(page);
  expect(before.readings.map(({ question }) => question)).toEqual(['Draw saved only in this tab']);
  await restore.evaluate((enable) => enable());
  await restore.dispose();
  expect(await guestBackup(page)).toEqual(before);

  const sibling = await context.newPage();
  await sibling.goto('/');
  await sibling.getByLabel(/What’s on your mind/).fill('Draw saved in the other tab');
  await sibling.getByRole('button', { name: /Draw Cards/ }).click();
  await expect.poll(() => questions(sibling)).toEqual(['Draw saved in the other tab']);
  const combined = await guestBackup(page);
  expect(combined.readings).toHaveLength(2);
  expect(combined.readings).toContainEqual(before.readings[0]);
  await page.reload();
  await page.getByLabel('Journal backup file').setInputFiles({
    name: 'guest.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(combined)),
  });
  await page.getByRole('button', { name: 'Confirm import' }).click();
  await expect
    .poll(() => questions(page))
    .toEqual(combined.readings.map(({ question }) => question));
});

test('a guest tab denied coordination can export its edits and preserves the shared journal', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await page.getByLabel(/What’s on your mind/).fill('Saved in the other tab');
  await page.getByRole('button', { name: /Draw Cards/ }).click();
  await expect.poll(() => questions(page)).toEqual(['Saved in the other tab']);
  const restricted = await context.newPage();
  await restricted.addInitScript(() => {
    Object.defineProperty(navigator, 'locks', { value: undefined });
    Object.defineProperty(window, 'Worker', { value: undefined });
  });
  await restricted.goto('/');
  await restricted.getByRole('button', { name: 'New Reading' }).click();
  await restricted.getByLabel(/What’s on your mind/).fill('Tab-only draw');
  await restricted.getByRole('button', { name: /Draw Cards/ }).click();
  await expect(restricted.getByText(/Your edits are available in this tab/)).toBeVisible();
  await restricted.getByRole('link', { name: /^Journal/ }).click();
  await restricted.getByRole('button', { name: 'Delete reading: Saved in the other tab' }).click();
  await restricted.getByRole('dialog').getByRole('button', { name: 'Delete Reading' }).click();
  await expect(restricted.getByText(/could not coordinate the deletion/)).toBeVisible();
  await expect(restricted.getByRole('heading', { name: 'Saved in the other tab' })).toBeVisible();
  const data = await guestBackup(restricted);
  expect(data.readings.map(({ question }) => question).sort()).toEqual([
    'Saved in the other tab',
    'Tab-only draw',
  ]);
  expect(await questions(page)).toEqual(['Saved in the other tab']);
});

for (const mode of ['mixed window and worker locks', 'legacy IndexedDB'] as const) {
  test(`guest delete and concurrent draw share one lock with ${mode}`, async ({
    page,
    context,
  }) => {
    const legacy = mode === 'legacy IndexedDB';
    if (legacy) {
      await context.addInitScript(() => {
        Reflect.deleteProperty(window, 'LockManager');
        Reflect.deleteProperty(Navigator.prototype, 'locks');
      });
    } else {
      await page.addInitScript(() =>
        Object.defineProperty(navigator, 'locks', { value: undefined }),
      );
    }
    await page.goto('/');
    await page.getByLabel(/What’s on your mind/).fill('Original spread');
    await page.getByRole('button', { name: /Draw Cards/ }).click();
    await page.getByRole('link', { name: /^Journal/ }).click();
    await page.getByRole('button', { name: 'Delete reading: Original spread' }).click();
    const sibling = await context.newPage();
    await sibling.goto('/');
    await sibling.getByRole('button', { name: 'New Reading' }).click();
    await sibling.getByLabel(/What’s on your mind/).fill('Concurrent draw');

    // Hold the selected primitive so both UI changes enter their normal
    // critical section while the other tab's operation is also pending.
    const holder = await sibling.evaluateHandle(async (legacy) => {
      const name = 'arcana.guest-journal.write';
      return new Promise<() => void>((acquired, reject) => {
        if (!legacy) {
          void navigator.locks.request(name, () => new Promise<void>(acquired)).catch(reject);
          return;
        }
        const open = indexedDB.open(name, 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          const transaction = database.transaction('writers', 'readwrite');
          const store = transaction.objectStore('writers');
          transaction.oncomplete = () => database.close();
          let holding = true;
          const keep = () => {
            if (holding) store.get('test').onsuccess = keep;
          };
          store.get('test').onsuccess = () => {
            keep();
            acquired(() => {
              holding = false;
            });
          };
        };
      });
    }, legacy);
    try {
      await Promise.all([
        page.getByRole('dialog').getByRole('button', { name: 'Delete Reading' }).click(),
        sibling.getByRole('button', { name: /Draw Cards/ }).click(),
      ]);
      await expect(page.getByRole('heading', { name: 'Original spread' })).toHaveCount(0);
      expect(await questions(page)).toEqual(['Original spread']);
      expect(await warnsBeforeClose(page)).toBe(true);
      expect(await warnsBeforeClose(sibling)).toBe(true);
    } finally {
      await holder.evaluate((release) => release());
      await holder.dispose();
    }
    await expect.poll(() => questions(page)).toEqual(['Concurrent draw']);
    await expect(page.getByRole('heading', { name: 'Concurrent draw' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Original spread' })).toHaveCount(0);
    await expect.poll(() => warnsBeforeClose(page)).toBe(false);
    await expect.poll(() => warnsBeforeClose(sibling)).toBe(false);
    await sibling.reload();
    await expect(sibling.getByText('Concurrent draw', { exact: true })).toBeVisible();
  });
}
