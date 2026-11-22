import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { expect } from '@playwright/test';
import { withApp, authenticate } from '../../../../../../test/emulator/journalBrowser.mjs';

test(
  'a trusted tab with read-only storage hides the journal and explains the scope of its lock',
  withApp(async (base, browser) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const email = 'read-only-' + randomUUID() + '@example.test';
    const password = 'read-only-' + randomUUID();
    await authenticate(base, page, email, password, { signup: true, trust: true });
    const question = 'Visible only before locking and after owner unlock';
    await page.goto(base);
    await page.getByLabel(/What’s on your mind/).fill(question);
    await page.getByRole('button', { name: /Draw Cards/ }).click();
    await page.getByRole('link', { name: /^Journal/ }).click();
    await expect(page.getByText('Journal synced.', { exact: true })).toBeVisible();
    const sibling = await context.newPage();
    await sibling.goto(base + '/journal');
    await expect(sibling.getByRole('heading', { name: question })).toBeVisible();
    await page.evaluate(() => {
      for (const method of ['setItem', 'removeItem']) {
        const original = Storage.prototype[method];
        Storage.prototype[method] = function (...args) {
          if (this === localStorage)
            throw new DOMException('Browser storage is read-only', 'SecurityError');
          return original.apply(this, args);
        };
      }
    });
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Lock journal' }).click();
    await expect(page.getByRole('heading', { name: 'Journal locked' })).toBeVisible();
    await expect(page.getByText(question)).toHaveCount(0);
    await expect(page.getByRole('main').getByRole('alert')).toContainText(/only lock this tab/i);
    await expect(page.getByRole('button', { name: 'Export journal' })).toHaveCount(0);
    await expect(sibling.getByRole('heading', { name: email })).toBeVisible();
    await context.setOffline(false);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Unlock journal' }).click();
    await expect(page.getByRole('heading', { name: email })).toBeVisible();
    await expect(page.getByRole('heading', { name: question })).toBeVisible();
    // Reloading this isolated page also restores its normal Web Storage methods.
    await page.reload();
    await expect(page.getByText('Journal synced.', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: question })).toBeVisible();
  }),
);

test(
  'a trusted journal locks with a pending draw and requires its owner after reopening',
  withApp(async (base, browser) => {
    const trusted = await browser.newContext();
    const first = await trusted.newPage();
    const email = 'owner-' + randomUUID() + '@example.test';
    const password = 'owner-' + randomUUID();
    const otherEmail = 'other-' + randomUUID() + '@example.test';
    const otherPassword = 'other-' + randomUUID();
    const question = 'A private question drawn offline';
    const openReading = (page) =>
      page.getByRole('button', { name: /^Open reading: A private question drawn offline/ });
    const assertLocked = async (page) => {
      await expect(page.getByRole('heading', { name: 'Journal locked' })).toBeVisible();
      await expect(page.getByText(question)).toHaveCount(0);
      await expect(
        page.getByRole('button', {
          name: /Export journal|Copy Reading|Download unsynced readings/,
        }),
      ).toHaveCount(0);
    };
    await authenticate(base, first, email, password, { signup: true, trust: true });
    const otherDevice = await browser.newPage();
    await authenticate(base, otherDevice, otherEmail, otherPassword, { signup: true });
    const sibling = await trusted.newPage();
    await sibling.goto(base + '/journal');
    await expect(sibling.getByRole('heading', { name: email })).toBeVisible();
    await first.goto(base);
    await expect(first.getByLabel(/What’s on your mind/)).toBeVisible();
    await trusted.setOffline(true);
    await first.getByLabel(/What’s on your mind/).fill(question);
    await first.getByRole('button', { name: /Draw Cards/ }).click();
    await first.getByRole('button', { name: 'Reveal card 1', exact: true }).click();
    const revealed = await first
      .getByRole('button', { name: /View card details/ })
      .getAttribute('aria-label');
    await first.getByRole('link', { name: /^Journal/ }).click();
    await expect(openReading(first)).toBeVisible();
    await expect(first.getByRole('button', { name: 'Sign out' })).toBeDisabled();
    await expect(openReading(sibling)).toBeVisible();
    await openReading(sibling).click();
    await expect(sibling.getByText(question)).toBeVisible();
    await first.getByRole('button', { name: 'Lock journal', exact: true }).click();
    await assertLocked(first);
    await assertLocked(sibling);
    await first.close();
    await sibling.close();

    // Serve the app shell again while both Firebase services are still unreachable.
    const firebase = /^http:\/\/127\.0\.0\.1:(8080|9099)\//;
    await trusted.route(firebase, (route) => route.abort('internetdisconnected'));
    await trusted.setOffline(false);
    const reopened = await trusted.newPage();
    for (const path of ['/', '/journal', '/login']) {
      await reopened.goto(base + path);
      await assertLocked(reopened);
    }
    await reopened.getByLabel('Password', { exact: true }).fill(password);
    await reopened.getByRole('button', { name: 'Unlock journal' }).click();
    await expect(reopened.getByRole('main').getByRole('alert')).toContainText(
      /connect to the internet/i,
    );
    await assertLocked(reopened);
    await trusted.unroute(firebase);
    // A separate device should receive the persisted draw and reveal while this
    // browser is still at the lock screen and has never submitted a valid password.
    const ownerDevice = await browser.newPage();
    await authenticate(base, ownerDevice, email, password);
    await expect(openReading(ownerDevice)).toBeVisible({ timeout: 30000 });
    await openReading(ownerDevice).click();
    await expect(ownerDevice.getByRole('button', { name: revealed, exact: true })).toBeVisible();
    await assertLocked(reopened);
    await ownerDevice.close();
    await reopened.getByLabel('Password', { exact: true }).fill(otherPassword);
    await reopened.getByRole('button', { name: 'Unlock journal' }).click();
    await expect(reopened.getByRole('main').getByRole('alert')).toBeVisible();
    await assertLocked(reopened);
    await reopened.getByRole('button', { name: 'Send password reset email' }).click();
    await expect(reopened.getByRole('status')).toContainText(/check your account inbox/i);
    await assertLocked(reopened);
    const authEmulator = 'http://127.0.0.1:9099';
    const mailbox = await fetch(
      authEmulator + '/emulator/v1/projects/demo-arcana-journal/oobCodes',
    );
    const { oobCodes } = await mailbox.json();
    const message = oobCodes.find(
      (code) => code.email === email && code.requestType === 'PASSWORD_RESET',
    );
    assert.ok(message, 'The locked account owner should receive the reset link');
    const newPassword = 'new-owner-' + randomUUID();
    const reset = await fetch(
      authEmulator +
        '/identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=demo-arcana-journal',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oobCode: message.oobCode, newPassword }),
      },
    );
    assert.ok(reset.ok, 'The password reset link should be usable');
    await reopened.getByLabel('Password', { exact: true }).fill(newPassword);
    await reopened.getByRole('button', { name: 'Unlock journal' }).click();
    await expect(reopened.getByRole('heading', { name: 'Journal locked' })).toHaveCount(0);
    await reopened.goto(base + '/journal');
    await expect(openReading(reopened)).toBeVisible();
    await expect(reopened.getByText('Journal synced.', { exact: true })).toBeVisible();

    // A fresh server-backed session must receive the offline draw only as its owner.
    await expect(openReading(otherDevice)).toHaveCount(0);
    await otherDevice.getByRole('button', { name: 'Sign out' }).click();
    await expect(
      otherDevice.getByRole('main').getByRole('link', { name: 'Sign in' }),
    ).toBeVisible();
    await authenticate(base, otherDevice, email, newPassword);
    await openReading(otherDevice).click();
    await expect(otherDevice.getByRole('button', { name: revealed, exact: true })).toBeVisible();
    await expect(
      otherDevice.getByRole('button', { name: 'Reveal card 2', exact: true }),
    ).toBeVisible();

    await reopened.getByRole('button', { name: 'Sign out' }).click();
    await expect(reopened.getByRole('main').getByRole('link', { name: 'Sign in' })).toBeVisible();
    await expect(openReading(reopened)).toHaveCount(0);
    await authenticate(base, reopened, otherEmail, otherPassword, { trust: true });
    await expect(openReading(reopened)).toHaveCount(0);
  }),
);
