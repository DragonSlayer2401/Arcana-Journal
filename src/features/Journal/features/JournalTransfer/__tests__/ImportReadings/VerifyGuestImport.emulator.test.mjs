import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { expect } from '@playwright/test';
import { verifyEmulatorEmail } from '../../../../../../../scripts/emulator-email.mjs';
import { guestStorageKey } from '../../../GuestJournal/utils/guestStorageKey.ts';
import { withApp, downloadReadings } from '../../../../../../test/emulator/journalBrowser.mjs';

test(
  'guest readings stay local until email verification and confirmed import, then sync across browsers',
  withApp(async (base, browser) => {
    const context = await browser.newContext();
    const first = await context.newPage();
    const second = await browser.newPage();
    let firestoreRequests = 0;
    first.on('request', (request) => {
      if (new URL(request.url()).port === '8080') firestoreRequests++;
    });
    for (const page of [first, second]) {
      await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
      });
    }
    const email = 'journal-' + randomUUID() + '@example.test';
    const password = 'Local-emulator-' + randomUUID();
    const authenticate = async (page, action) => {
      const signup = action === 'Create account';
      await expect(page).toHaveURL(base + (signup ? '/signup' : '/login'));
      const form = page.getByRole('main');
      await expect(form.getByRole('heading', { level: 1, name: action })).toBeVisible();
      await form.getByLabel('Email address').fill(email);
      await form.getByLabel('Password', { exact: true }).fill(password);
      if (signup) await form.getByLabel('Confirm password').fill(password);
      await form.getByRole('button', { name: action, exact: true }).click();
      await expect(page).toHaveURL(base + '/journal');
      await expect(page.getByRole('heading', { name: email })).toBeVisible();
    };
    const openReading = (page) =>
      page.getByRole('button', { name: /^Open reading: A journal to bring along/ });
    await first.goto(base);
    await first.getByLabel(/What’s on your mind/).fill('A journal to bring along');
    await first.getByRole('button', { name: /Draw Cards/ }).click();
    await first.getByRole('button', { name: 'Reveal card 1', exact: true }).click();
    await first.getByRole('link', { name: /^Journal/ }).click();
    await first.getByRole('main').getByRole('link', { name: 'Create account' }).click();
    await authenticate(first, 'Create account');
    await expect(openReading(first)).toBeVisible();
    await expect(first.getByRole('button', { name: 'Import this device’s journal' })).toHaveCount(
      0,
    );
    await first.getByRole('button', { name: 'Check verification' }).click();
    await expect(first.getByRole('button', { name: 'Check verification' })).toBeEnabled();
    await openReading(first).click();
    await first.getByRole('button', { name: 'New Reading', exact: true }).click();
    await first.getByLabel(/What’s on your mind/).fill('While waiting for my verification email');
    await first.getByRole('button', { name: /Draw Cards/ }).click();
    await first.getByRole('link', { name: /^Journal/ }).click();
    const localReadings = await downloadReadings(first, 'Export journal');
    assert.deepEqual(localReadings.map((reading) => reading.question).sort(), [
      'A journal to bring along',
      'While waiting for my verification email',
    ]);
    await first.goBack();
    await first.evaluate((journalKey) => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (this === localStorage && key === journalKey) {
          Storage.prototype.setItem = setItem;
          throw new DOMException('Guest storage is full', 'QuotaExceededError');
        }
        return setItem.call(this, key, value);
      };
    }, guestStorageKey);
    await first.getByRole('button', { name: 'Reveal card 1', exact: true }).click();
    await expect(first.getByText(/your cards are still available in this session/i)).toBeVisible();
    const sibling = await context.newPage();
    await sibling.goto(base);
    await sibling.getByRole('button', { name: 'Reveal card 2', exact: true }).click();
    await expect(sibling.getByRole('button', { name: /View card details/ })).toHaveCount(1);
    await sibling.close();
    await first.getByRole('link', { name: /^Journal/ }).click();
    assert.equal(firestoreRequests, 0, 'An unverified session should use only the local journal');
    await verifyEmulatorEmail(email);
    await first.getByRole('button', { name: 'Check verification' }).click();
    await expect(first.getByRole('button', { name: 'Check verification' })).toHaveCount(0);
    await expect(openReading(first)).toHaveCount(0);
    const guestBackup = await downloadReadings(first, 'Download guest backup');
    const expectedReadings = localReadings.map((reading) =>
      reading.question === 'While waiting for my verification email'
        ? { ...reading, revealed: [true, true, false] }
        : reading,
    );
    assert.deepEqual(guestBackup, expectedReadings);
    assert.deepEqual(await downloadReadings(first, 'Export journal'), []);
    await first.getByRole('button', { name: 'Import this device’s journal' }).click();
    await expect(first.getByRole('dialog').getByText(email, { exact: true })).toBeVisible();
    await first.getByRole('button', { name: 'Confirm import' }).click();
    await expect(first.getByText('Imported 2 readings.')).toBeVisible();
    assert.deepEqual(
      new Set(await downloadReadings(first, 'Export journal')),
      new Set(expectedReadings),
    );
    await second.goto(base);
    await second.getByRole('banner').getByRole('link', { name: 'Sign in' }).click();
    await authenticate(second, 'Sign in');
    await openReading(second).click();
    await expect(second.getByRole('button', { name: /View card details/ })).toHaveCount(1);
    await second.getByRole('button', { name: 'Reveal card 2', exact: true }).click();
    await openReading(first).click();
    await expect(first.getByRole('button', { name: /View card details/ })).toHaveCount(2);
    for (const page of [first, second]) {
      await page.getByRole('link', { name: /^Journal/ }).click();
      await page.getByRole('button', { name: 'Sign out' }).click();
      await expect(
        page.getByRole('main').getByRole('link', { name: 'Create account' }),
      ).toBeVisible();
    }
    await expect(openReading(second)).toHaveCount(0);
    await openReading(first).click();
    await expect(first.getByRole('button', { name: /View card details/ })).toHaveCount(1);
    await first.getByRole('link', { name: /^Journal/ }).click();
    await first.getByRole('button', { name: 'Clear History' }).click();
    await first.getByRole('button', { name: 'Clear All Readings' }).click();
    await expect(
      first.getByText('Guest history and its recovery copies were cleared from this device.'),
    ).toBeVisible();
    await first.reload();
    await expect(openReading(first)).toHaveCount(0);
    await first.getByRole('main').getByRole('link', { name: 'Sign in' }).click();
    await authenticate(first, 'Sign in');
    const accountReadings = await downloadReadings(first, 'Export journal');
    assert.equal(accountReadings.length, 2);
    assert.deepEqual(
      accountReadings.find(({ question }) => question === 'A journal to bring along').revealed,
      [true, true, false],
    );
  }),
);
