import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { chromium, expect, webkit } from '@playwright/test';
import {
  withApp,
  authenticate,
  importReadings,
} from '../../../../../../test/emulator/journalBrowser.mjs';

for (const browserType of [chromium, webkit]) {
  test(
    `switching a restored session to trusted receives sign-out from another tab in ${browserType.name()}`,
    withApp(async (base, browser) => {
      const profile = await browser.newContext();
      const page = await profile.newPage();
      const email = 'restored-session-' + randomUUID() + '@example.test';
      const password = randomUUID();
      await authenticate(base, page, email, password, { signup: true });
      const reading = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        question: 'A reading from this account',
        cards: [{ cardId: 'major-00', orientation: 'upright' }],
        revealed: [false],
      };
      await importReadings(page, [reading]);
      await page.reload();
      await expect(page.getByRole('heading', { name: email })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Lock journal' })).toHaveCount(0);
      await page.getByRole('button', { name: 'Sign out' }).click();

      // Stay in the same app instance that Firebase restored from session storage.
      await page.getByRole('main').getByRole('link', { name: 'Sign in' }).click();
      await page.getByLabel('Email address').fill(email);
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('checkbox').check();
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Lock journal' })).toBeVisible();
      await expect(page.getByRole('heading', { name: reading.question })).toBeVisible();
      const sibling = await profile.newPage();
      await sibling.goto(base + '/journal');
      await expect(sibling.getByRole('heading', { name: email })).toBeVisible();
      await sibling.getByRole('button', { name: 'Sign out' }).click();
      await expect(sibling.getByRole('main').getByRole('link', { name: 'Sign in' })).toBeVisible();
      await page.bringToFront();
      await expect(page.getByRole('main').getByRole('link', { name: 'Sign in' })).toBeVisible();
      await expect(page.getByRole('heading', { name: email })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: reading.question })).toHaveCount(0);
    }, browserType),
  );
}

for (const browserType of [chromium, webkit]) {
  test(
    `a failed sign-out hides the journal until the owner can finish signing out in ${browserType.name()}`,
    withApp(async (base, browser) => {
      const context = await browser.newContext();
      await context.addInitScript(() => {
        Object.defineProperty(window, 'indexedDB', { value: undefined });
      });
      const page = await context.newPage();
      const email = 'sign-out-' + randomUUID() + '@example.test';
      const password = 'sign-out-' + randomUUID();
      await authenticate(base, page, email, password, { signup: true, trust: true });
      await page.goto(base);
      const question = 'A private reading before signing out';
      await page.getByLabel(/What’s on your mind/).fill(question);
      await page.getByRole('button', { name: /Draw Cards/ }).click();
      await page.getByRole('link', { name: /^Journal/ }).click();
      await expect(
        page.getByText('Cloud readings synced. Saved deletions could not be checked.', {
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.getByRole('heading', { name: question })).toBeVisible();
      await page.evaluate(() => {
        const originals = {
          setItem: Storage.prototype.setItem,
          removeItem: Storage.prototype.removeItem,
        };
        for (const method of Object.keys(originals)) {
          Storage.prototype[method] = function (...args) {
            if (this === localStorage)
              throw new DOMException('Storage is read-only', 'SecurityError');
            return originals[method].apply(this, args);
          };
        }
        window.restoreSignOutStorage = () => Object.assign(Storage.prototype, originals);
      });
      await page.getByRole('button', { name: 'Sign out' }).click();
      await expect(page.getByRole('heading', { name: 'Sign-out incomplete' })).toBeVisible();
      await expect(page.getByText(question)).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Export available readings' })).toHaveCount(0);
      await page.getByRole('button', { name: 'Retry sign out' }).click();
      await expect(page.getByRole('main').getByRole('alert')).toHaveCount(2);
      await expect(page.getByRole('button', { name: 'Retry sign out' })).toBeEnabled();
      await page.evaluate(() => window.restoreSignOutStorage());
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Sign-out incomplete' })).toBeVisible();
      await expect(page.getByText(question)).toHaveCount(0);
      await page.getByRole('button', { name: 'Retry sign out' }).click();
      await expect(page.getByRole('main').getByRole('link', { name: 'Sign in' })).toBeVisible();
      await page.reload();
      await expect(page.getByRole('main').getByRole('link', { name: 'Sign in' })).toBeVisible();
      await expect(page.getByText(question)).toHaveCount(0);
      await authenticate(base, page, email, password, { trust: true });
      await expect(page.getByRole('heading', { name: question })).toBeVisible();
    }, browserType),
  );
}
