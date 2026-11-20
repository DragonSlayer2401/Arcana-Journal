import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';

test('two browsers can import a guest journal, sync a reveal, and sign out to separate guest journals', async () => {
  const emulators = await (await fetch('http://127.0.0.1:4400/emulators')).json();
  assert.equal(emulators.auth.port, 9099);
  assert.equal(emulators.firestore.port, 8080);
  const server = await createServer({
    mode: 'emulator',
    logLevel: 'warn',
    server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  let browser;
  try {
    await server.listen();
    const base = 'http://127.0.0.1:' + server.httpServer.address().port;
    browser = await chromium.launch();
    const first = await browser.newPage();
    const second = await browser.newPage();
    for (const page of [first, second]) {
      await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
      });
    }
    const email = 'journal-' + randomUUID() + '@example.test';
    const password = 'Local-emulator-' + randomUUID();
    const authenticate = async (page, action) => {
      await page.getByRole('button', { name: action, exact: true }).click();
      const form = page.getByRole('dialog');
      await form.getByLabel('Email address').fill(email);
      await form.getByLabel('Password', { exact: true }).fill(password);
      await form.getByRole('button', { name: action, exact: true }).click();
      await expect(page.getByRole('heading', { name: email })).toBeVisible();
    };
    const openReading = (page) =>
      page.getByRole('button', { name: /^Open reading: A journal to bring along/ });
    await first.goto(base);
    await first.getByLabel(/What’s on your mind/).fill('A journal to bring along');
    await first.getByRole('button', { name: /Draw Cards/ }).click();
    await first.getByRole('button', { name: 'Reveal card 1', exact: true }).click();
    await first.getByRole('link', { name: /^Journal/ }).click();
    await authenticate(first, 'Create account');
    await expect(openReading(first)).toHaveCount(0);
    await first.getByRole('button', { name: 'Import this device’s journal' }).click();
    await expect(first.getByRole('dialog').getByText(email, { exact: true })).toBeVisible();
    await first.getByRole('button', { name: 'Confirm import' }).click();
    await expect(first.getByText('Imported 1 reading.')).toBeVisible();
    await second.goto(base + '/journal');
    await authenticate(second, 'Sign in');
    await openReading(second).click();
    await expect(second.getByRole('button', { name: /View card details/ })).toHaveCount(1);
    await second.getByRole('button', { name: 'Reveal card 2', exact: true }).click();
    await openReading(first).click();
    await expect(first.getByRole('button', { name: /View card details/ })).toHaveCount(2);
    for (const page of [first, second]) {
      await page.getByRole('link', { name: /^Journal/ }).click();
      await page.getByRole('button', { name: 'Sign out' }).click();
      await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible();
    }
    await expect(openReading(second)).toHaveCount(0);
    await openReading(first).click();
    await expect(first.getByRole('button', { name: /View card details/ })).toHaveCount(1);
  } finally {
    await browser?.close();
    await server.close();
  }
});
