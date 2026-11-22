import { readFile } from 'node:fs/promises';
import { after, before } from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startEmulatorApp } from '../../../scripts/emulator-app.mjs';
import { verifyEmulatorEmail } from '../../../scripts/emulator-email.mjs';

let server;
before(async () => {
  server = await startEmulatorApp();
});
after(() => server?.close());

export const withApp =
  (run, browserType = chromium) =>
  async () => {
    const browser = await browserType.launch();
    try {
      await run(server.base, browser);
    } finally {
      await browser.close();
    }
  };

export const authenticate = async (
  base,
  page,
  address,
  secret,
  { signup = false, trust = false, waitForSync = true } = {},
) => {
  await page.goto(base + (signup ? '/signup' : '/login'));
  await page.getByLabel('Email address').fill(address);
  await page.getByLabel('Password', { exact: true }).fill(secret);
  if (signup) await page.getByLabel('Confirm password').fill(secret);
  if (trust) await page.getByRole('checkbox').check();
  await page
    .getByRole('button', { name: signup ? 'Create account' : 'Sign in', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: address })).toBeVisible();
  if (signup) {
    await verifyEmulatorEmail(address);
    await page.getByRole('button', { name: 'Check verification' }).click();
  }
  if (waitForSync)
    await expect(
      page.getByText(
        /^(Journal synced\.|Cloud readings synced\. Saved deletions could not be checked\.)$/,
      ),
    ).toBeVisible();
};

export const downloadReadings = async (page, button) => {
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: button, exact: true }).click();
  const file = await downloading;
  return JSON.parse(await readFile(await file.path(), 'utf8')).readings;
};

export const chooseReadings = (page, readings) =>
  page.getByLabel('Journal backup file').setInputFiles({
    name: 'readings.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ version: 1, readings })),
  });

export const importReadings = async (
  page,
  readings,
  expectedStatus = `Imported ${readings.length} ${readings.length === 1 ? 'reading' : 'readings'}.`,
) => {
  await chooseReadings(page, readings);
  await page.getByRole('button', { name: 'Confirm import' }).click();
  await expect(page.getByText(expectedStatus, { exact: true })).toBeVisible();
};

export const deleteFromJournal = async (page, reading) => {
  await page.getByRole('button', { name: 'Delete reading: ' + reading.question }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete Reading' }).click();
  await expect(page.getByRole('heading', { name: reading.question })).toHaveCount(0);
};

export const retainTabReading = (page, reading) =>
  page.evaluate(async (reading) => {
    const { observeAccount } = window.kit.journal;
    const { saveTabRecoveryCopy } = window.kit;
    const { retainRecoveryCopies } = window.kit.readingRecovery;
    const uid = await new Promise((resolve) => {
      const stop = observeAccount((user) => {
        stop();
        resolve(user.uid);
      });
    });
    const key = saveTabRecoveryCopy(uid, reading);
    retainRecoveryCopies(uid, [{ key, reading }]);
    return uid;
  }, reading);
