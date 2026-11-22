import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { expect } from '@playwright/test';
import {
  withApp,
  authenticate,
  downloadReadings,
  importReadings,
} from '../../../../../../test/emulator/journalBrowser.mjs';

const openTabsWithMemoryOnlyWrites = async (base, browser, webLocks) => {
  const context = await browser.newContext();
  await context.addInitScript((webLocks) => {
    Object.defineProperty(window, 'indexedDB', { value: undefined });
    if (!webLocks) Object.defineProperty(navigator, 'locks', { value: undefined });
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (this === localStorage && key.startsWith('arcana.journal.recovery.'))
        throw new DOMException('Recovery storage is full', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
  }, webLocks);
  const writer = await context.newPage();
  const email = 'two-tabs-' + randomUUID() + '@example.test';
  const password = 'two-tabs-' + randomUUID();
  await authenticate(base, writer, email, password, { signup: true, trust: true });
  const sibling = await context.newPage();
  await sibling.goto(base + '/journal');
  await expect(
    sibling.getByText('Cloud readings synced. Saved deletions could not be checked.', {
      exact: true,
    }),
  ).toBeVisible();
  await writer.goto(base);
  await expect(writer.getByLabel(/What’s on your mind/)).toBeVisible();
  await context.setOffline(true);
  const question = 'Keep this spread through sign-out';
  await writer.getByLabel(/What’s on your mind/).fill(question);
  await writer.getByRole('button', { name: /Draw Cards/ }).click();
  await writer.getByRole('button', { name: 'Reveal card 2', exact: true }).click();
  await writer.getByRole('link', { name: /^Journal/ }).click();
  await expect(writer.getByText(/Closing this tab could lose unsynced changes/)).toBeVisible();
  const expected = await downloadReadings(writer, 'Download unsynced readings');
  assert.equal(expected.length, 1);
  assert.equal(expected[0].question, question);
  assert.deepEqual(expected[0].revealed, [false, true, false]);
  return { context, writer, sibling, email, password, question, expected };
};

test(
  'an unsynced backup restores a lone reveal to its assigned reading in another browser',
  withApp(async (base, browser) => {
    const context = await browser.newContext();
    const writer = await context.newPage();
    const reader = await browser.newPage();
    const email = 'portable-reveal-' + randomUUID() + '@example.test';
    const password = randomUUID();
    await authenticate(base, writer, email, password, { signup: true, trust: true });
    await authenticate(base, reader, email, password);
    const original = {
      id: randomUUID(),
      createdAt: '2026-11-01T12:00:00.000Z',
      question: 'Two independently saved copies of this spread',
      cards: [{ cardId: 'major-00', orientation: 'upright' }],
      revealed: [false],
    };
    const assigned = await writer.evaluate(async (reading) => {
      const { collisionReadingId } = window.kit;
      return { ...reading, id: await collisionReadingId(reading) };
    }, original);
    await importReadings(reader, [original, assigned]);
    await expect(writer.getByRole('heading', { name: original.question })).toHaveCount(2);

    await writer.evaluate(
      async ({ original, assigned }) => {
        const { observeAccount } = window.kit.journal;
        const { loadRecoveryCopies, importTargetRecorder, saveRecoveryCopy } =
          window.kit.readingRecovery;
        const uid = await new Promise((resolve) => {
          const stop = observeAccount((user) => {
            stop();
            resolve(user.uid);
          });
        });
        const updated = { ...original, revealed: [true] };
        saveRecoveryCopy(uid, updated);
        await importTargetRecorder(loadRecoveryCopies(uid).copies, updated)(assigned.id);
        window.dispatchEvent(new Event('focus'));
      },
      { original, assigned },
    );
    await context.setOffline(true);
    const backup = await downloadReadings(writer, 'Download unsynced readings');
    const updated = { ...assigned, revealed: [true] };
    assert.deepEqual(backup, [{ ...updated, sourceId: original.id }]);

    await importReadings(
      reader,
      backup,
      'Imported 0 readings. Updated reveal progress for 1 reading.',
    );
    const restored = await downloadReadings(reader, 'Export journal');
    assert.equal(restored.length, 2);
    assert.deepEqual(
      restored.find(({ id }) => id === original.id),
      original,
    );
    assert.deepEqual(
      restored.find(({ id }) => id === assigned.id),
      updated,
    );
  }),
);

test(
  'signing out from another tab preserves an offline reading held only in memory',
  withApp(async (base, browser) => {
    const { context, writer, sibling, email, password, question, expected } =
      await openTabsWithMemoryOnlyWrites(base, browser, true);
    const signOut = sibling.getByRole('button', { name: 'Sign out' });
    await signOut.click();
    await expect(sibling.getByRole('main').getByRole('alert')).toContainText(/tab/i);
    await expect(writer.getByRole('heading', { name: question })).toBeVisible();
    await expect(writer.getByRole('button', { name: 'Sign out' })).toBeDisabled();

    await context.setOffline(false);
    await expect(
      writer.getByText('Cloud readings synced. Saved deletions could not be checked.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(sibling.getByRole('heading', { name: question })).toBeVisible();
    await signOut.click();
    for (const page of [writer, sibling]) {
      await expect(page.getByRole('main').getByRole('link', { name: 'Sign in' })).toBeVisible();
    }
    await authenticate(base, writer, email, password, { trust: true });
    assert.deepEqual(await downloadReadings(writer, 'Export available readings'), expected);
  }),
);

test(
  'without Web Locks, the open tab keeps unsynced readings private until the same owner returns',
  withApp(async (base, browser) => {
    const { context, writer, sibling, email, password, question, expected } =
      await openTabsWithMemoryOnlyWrites(base, browser, false);
    await sibling.getByRole('button', { name: 'Sign out' }).click();
    await expect(writer.getByRole('main').getByRole('link', { name: 'Sign in' })).toBeVisible();
    await context.setOffline(false);
    const otherEmail = 'other-' + randomUUID() + '@example.test';
    const otherPassword = 'other-' + randomUUID();
    const otherDevice = await browser.newPage();
    await authenticate(base, otherDevice, otherEmail, otherPassword, { signup: true });
    await authenticate(base, sibling, otherEmail, otherPassword, { trust: true });
    await expect(writer.getByRole('heading', { name: otherEmail })).toBeVisible();
    await expect(
      writer.getByText('Cloud readings synced. Saved deletions could not be checked.', {
        exact: true,
      }),
    ).toBeVisible();
    const recover = writer.getByRole('button', { name: 'Recover unsynced readings' });
    await expect(recover).toHaveCount(0);
    await expect(writer.getByText(question)).toHaveCount(0);
    assert.deepEqual(await downloadReadings(writer, 'Export available readings'), []);
    await sibling.getByRole('button', { name: 'Sign out' }).click();
    await expect(writer.getByRole('main').getByRole('link', { name: 'Sign in' })).toBeVisible();

    await authenticate(base, sibling, email, password, { trust: true });
    await recover.click();
    const review = writer.getByRole('dialog', { name: 'Review journal import' });
    await expect(review.getByText(email, { exact: true })).toBeVisible();
    await review.getByRole('button', { name: 'Confirm import' }).click();
    await expect(sibling.getByRole('heading', { name: question })).toBeVisible();
    assert.deepEqual(await downloadReadings(sibling, 'Export available readings'), expected);
  }),
);

test(
  'a trusted owner can recover the exact offline spread after closing a locked browser without IndexedDB',
  withApp(async (base, browser) => {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      Object.defineProperty(window, 'indexedDB', { value: undefined });
    });
    const page = await context.newPage();
    const email = 'fallback-' + randomUUID() + '@example.test';
    const password = 'fallback-' + randomUUID();
    await authenticate(base, page, email, password, { signup: true, trust: true });
    const remote = await browser.newPage();
    await authenticate(base, remote, email, password);
    await page.goto(base);
    const question = 'My offline spread without IndexedDB';
    await expect(page.getByLabel(/What’s on your mind/)).toBeVisible();
    await context.setOffline(true);
    await page.getByLabel(/What’s on your mind/).fill(question);
    await page.getByRole('button', { name: /Draw Cards/ }).click();
    await page.getByRole('button', { name: 'Reveal card 2', exact: true }).click();
    await page.getByRole('link', { name: /^Journal/ }).click();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeDisabled();
    const expected = await downloadReadings(page, 'Download unsynced readings');
    assert.equal(expected.length, 1);
    assert.equal(expected[0].question, question);
    assert.deepEqual(expected[0].revealed, [false, true, false]);
    await page.getByRole('button', { name: 'Lock journal' }).click();
    await expect(page.getByRole('heading', { name: 'Journal locked' })).toBeVisible();
    await page.close();
    await context.setOffline(false);

    const reopened = await context.newPage();
    await reopened.goto(base + '/journal');
    await expect(reopened.getByRole('heading', { name: 'Journal locked' })).toBeVisible();
    await expect(reopened.getByText(question)).toHaveCount(0);
    await reopened.getByLabel('Password', { exact: true }).fill(password);
    await reopened.getByRole('button', { name: 'Unlock journal' }).click();
    const recover = reopened.getByRole('button', { name: 'Recover unsynced readings' });
    await expect(recover).toBeVisible();
    // Access changes after the journal is displayed, first for all recovery
    // copies, then for just the newer copy with the second card revealed.
    await reopened.evaluate(() => {
      const getItem = Storage.prototype.getItem;
      let blockAll = true;
      Storage.prototype.getItem = function (key) {
        const value = getItem.call(this, key);
        if (
          this === localStorage &&
          key.startsWith('arcana.journal.recovery.') &&
          value &&
          (blockAll || JSON.parse(value).revealed[1])
        ) {
          throw new DOMException('Recovery storage unavailable', 'SecurityError');
        }
        return value;
      };
      window.allowOriginalDraw = () => {
        blockAll = false;
      };
      window.restoreRecoveryReads = () => {
        Storage.prototype.getItem = getItem;
      };
    });
    await reopened.getByRole('button', { name: 'Export available readings', exact: true }).click();
    await expect(
      reopened.getByText(/A complete backup needs access to every recovery copy/),
    ).toBeVisible();
    await expect(reopened.getByRole('link', { name: 'Download backup' })).toHaveCount(0);
    await expect(reopened.getByRole('button', { name: /Download.*unsynced readings/ })).toHaveCount(
      0,
    );
    await reopened.evaluate(() => window.allowOriginalDraw());
    await reopened.getByRole('button', { name: 'Retry sync' }).click();
    const partial = await downloadReadings(
      reopened,
      'Download available unsynced readings (partial backup)',
    );
    assert.deepEqual(partial, [{ ...expected[0], revealed: [false, false, false] }]);
    await expect(reopened.getByRole('link', { name: 'Download backup' })).toHaveAttribute(
      'download',
      /partial/,
    );
    await reopened.evaluate(() => window.restoreRecoveryReads());
    await reopened.getByRole('button', { name: 'Retry sync' }).click();
    assert.deepEqual(await downloadReadings(reopened, 'Export available readings'), expected);
    await reopened.getByRole('button', { name: 'Sign out' }).click();
    await expect(reopened.getByRole('main').getByRole('link', { name: 'Sign in' })).toBeVisible();
    await expect(recover).toHaveCount(0);
    await expect(reopened.getByText(question)).toHaveCount(0);
    const other = 'other-' + randomUUID() + '@example.test';
    await authenticate(base, reopened, other, 'other-' + randomUUID(), {
      signup: true,
      trust: true,
    });
    await expect(recover).toHaveCount(0);
    await expect(reopened.getByText(question)).toHaveCount(0);
    assert.deepEqual(await downloadReadings(reopened, 'Export available readings'), []);
    await reopened.getByRole('button', { name: 'Sign out' }).click();
    await expect(reopened.getByRole('main').getByRole('link', { name: 'Sign in' })).toBeVisible();
    await authenticate(base, reopened, email, password, { trust: true, waitForSync: false });
    await recover.click();
    const review = reopened.getByRole('dialog', { name: 'Review journal import' });
    await expect(review.getByText(email, { exact: true })).toBeVisible();
    assert.deepEqual(await downloadReadings(remote, 'Export journal'), []);
    await review.getByRole('button', { name: 'Confirm import' }).click();
    await expect(remote.getByRole('heading', { name: question })).toBeVisible();
    assert.deepEqual(await downloadReadings(remote, 'Export journal'), expected);
  }),
);
