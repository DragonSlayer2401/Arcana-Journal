import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { chromium, expect, webkit } from '@playwright/test';
import {
  withApp,
  authenticate,
  downloadReadings,
  importReadings,
  deleteFromJournal,
} from '../../../../../../test/emulator/journalBrowser.mjs';

test(
  'deleting an imported reading retires its legacy recovery copy across a reload',
  withApp(async (base, browser) => {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      const removeItem = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function (key) {
        if (this === localStorage && key === sessionStorage.getItem('read-only-recovery-key'))
          throw new DOMException('Removal unavailable', 'SecurityError');
        return removeItem.call(this, key);
      };
    });
    const page = await context.newPage();
    await authenticate(base, page, 'legacy-' + randomUUID() + '@example.test', randomUUID(), {
      signup: true,
      trust: true,
    });
    await page.goto(base);
    await page.getByLabel(/What’s on your mind/).fill('Keep the original reading');
    await page.getByRole('button', { name: /Draw Cards/ }).click();
    await page.getByRole('link', { name: /^Journal/ }).click();
    await expect(page.getByText('Journal synced.', { exact: true })).toBeVisible();
    const [original] = await downloadReadings(page, 'Export journal');
    const incoming = { ...original, question: 'Delete the imported reading' };
    await importReadings(page, [incoming]);
    // Simulate closing the importer after its cloud commit, with a more recent
    // reveal still in the original account's local recovery copy.
    const key = await page.evaluate(async (reading) => {
      const { observeAccount } = window.kit.journal;
      const { saveRecoveryCopy } = window.kit.readingRecovery;
      const uid = await new Promise((resolve) => {
        const stop = observeAccount((user) => {
          stop();
          resolve(user.uid);
        });
      });
      const key = saveRecoveryCopy(uid, { ...reading, revealed: reading.revealed.map(() => true) });
      sessionStorage.setItem('read-only-recovery-key', key);
      return key;
    }, incoming);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Discard recovery copies' })).toBeVisible();
    await deleteFromJournal(page, incoming);
    await expect(page.getByText(/waiting for removal/)).toBeVisible();
    await page.reload();
    await expect(page.getByText(/waiting for removal/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Discard recovery copies' })).toHaveCount(0);
    assert.deepEqual(await downloadReadings(page, 'Export journal'), [original]);
    await page.evaluate(() => sessionStorage.removeItem('read-only-recovery-key'));
    await page.getByRole('button', { name: 'Retry sync' }).click();
    await expect(page.getByText('Journal synced.', { exact: true })).toBeVisible();
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), key), null);
  }),
);

for (const browserType of [chromium, webkit]) {
  test(
    `offline deletes survive reopening and apply only to the originally selected spreads in ${browserType.name()}`,
    withApp(async (base, browser) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const peer = await browser.newPage();
      const email = 'verified-delete-' + randomUUID() + '@example.test';
      const password = randomUUID();
      await authenticate(base, page, email, password, { signup: true, trust: true });
      await authenticate(base, peer, email, password);
      const original = {
        id: 'legacy-' + randomUUID(),
        createdAt: '2026-11-01T12:00:00.000Z',
        question: 'The original spread',
        cards: [{ cardId: 'major-00', orientation: 'upright' }],
        revealed: [false],
      };
      const other = { ...original, id: randomUUID(), question: 'A second reading to delete' };
      await importReadings(peer, [original, other]);
      await expect(page.getByRole('heading', { name: other.question })).toBeVisible();
      const sibling = await context.newPage();
      await sibling.goto(base + '/journal');
      await expect(sibling.getByRole('heading', { name: original.question })).toBeVisible();
      await page.getByRole('button', { name: 'Delete reading: ' + original.question }).click();
      await sibling.getByRole('button', { name: 'Lock journal', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Journal locked' })).toBeVisible();
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Unlock journal' }).click();
      await expect(page.getByRole('heading', { name: original.question })).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await sibling.close();
      await context.setOffline(true);
      await deleteFromJournal(page, original);
      await deleteFromJournal(page, other);
      await expect(page.getByText('Changes waiting to sync.', { exact: true })).toBeVisible();
      await page.close();

      // A different device deletes the old spread and imports a new one at its ID.
      await deleteFromJournal(peer, original);
      const replacement = { ...original, question: 'A replacement with the same legacy ID' };
      await importReadings(peer, [replacement]);
      await expect(peer.getByRole('heading', { name: other.question })).toBeVisible();
      await context.setOffline(false);
      const reopened = await context.newPage();
      await reopened.goto(base + '/journal');
      await expect(reopened.getByRole('heading', { name: replacement.question })).toBeVisible();
      await expect(peer.getByRole('heading', { name: other.question })).toHaveCount(0);
      assert.deepEqual(await downloadReadings(peer, 'Export journal'), [replacement]);
      await reopened.reload();
      await expect(reopened.getByRole('heading', { name: replacement.question })).toBeVisible();
      assert.deepEqual(await downloadReadings(reopened, 'Export journal'), [replacement]);
    }, browserType),
  );
}

test(
  'a retained reading deleted offline stays out of backups after closing and reopening',
  withApp(async (base, browser) => {
    const context = await browser.newContext();
    const first = await context.newPage();
    const peer = await browser.newPage();
    const email = 'retained-delete-' + randomUUID() + '@example.test';
    const password = randomUUID();
    await authenticate(base, first, email, password, { signup: true, trust: true });
    await authenticate(base, peer, email, password);
    const reading = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      question: 'A reading recovered after an interrupted clear',
      cards: [{ cardId: 'major-01', orientation: 'upright' }],
      revealed: [true],
    };
    // An interrupted clear left a recovery copy that never had a cloud target.
    const uid = await first.evaluate(async (reading) => {
      const { observeAccount } = window.kit.journal;
      const { saveRecoveryCopy, prepareRecoveryDeletion } = window.kit.readingRecovery;
      const uid = await new Promise((resolve) => {
        const stop = observeAccount((user) => {
          stop();
          resolve(user.uid);
        });
      });
      const key = saveRecoveryCopy(uid, reading);
      prepareRecoveryDeletion([{ key, reading, targetId: null }]);
      return uid;
    }, reading);
    await first.addInitScript(() => {
      Object.defineProperty(window, 'indexedDB', { value: undefined });
      Object.defineProperty(window, 'Worker', { value: undefined });
    });
    await first.reload();
    await expect(first.getByRole('button', { name: 'Recover unsynced readings' })).toBeVisible();
    await first.getByRole('button', { name: 'Recover unsynced readings' }).click();
    const review = first.getByRole('dialog', { name: 'Review journal import' });
    await expect(review.getByText(/saved deletions could not be checked/i)).toBeVisible();
    await review.getByRole('button', { name: 'Confirm import' }).click();
    await expect(first.getByText(/your recovery copies are still available/i)).toBeVisible();
    const cloudRow = peer.getByRole('heading', { name: reading.question });
    await expect(cloudRow).toBeVisible();
    await first.close();

    const writer = await context.newPage();
    await writer.goto(base + '/journal');
    await expect(writer.getByRole('button', { name: 'Recover unsynced readings' })).toBeVisible();
    await expect(writer.getByRole('heading', { name: reading.question })).toBeVisible();
    await context.setOffline(true);
    await deleteFromJournal(writer, reading);
    await expect(writer.getByText('Changes waiting to sync.', { exact: true })).toBeVisible();
    await writer.close();
    await context.setOffline(false);
    const reopened = await context.newPage();
    await reopened.goto(base + '/journal');
    await expect(cloudRow).toHaveCount(0);
    await expect
      .poll(() =>
        reopened.evaluate(
          async ({ uid, id }) => {
            const { loadRecoveryCopies } = window.kit.readingRecovery;
            return loadRecoveryCopies(uid).prepared.some((copy) => copy.targetId === id);
          },
          { uid, id: reading.id },
        ),
      )
      .toBe(false);
    assert.deepEqual(await downloadReadings(reopened, 'Export journal'), []);
    await expect(reopened.getByRole('button', { name: 'Recover unsynced readings' })).toHaveCount(
      0,
    );
  }),
);

test(
  'closing before an offline deletion reaches Firebase preserves the unacknowledged reveal',
  withApp(async (base, browser) => {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      Object.defineProperty(window, 'indexedDB', { value: undefined });
    });
    const page = await context.newPage();
    await authenticate(
      base,
      page,
      'interrupted-delete-' + randomUUID() + '@example.test',
      randomUUID(),
      {
        signup: true,
        trust: true,
      },
    );
    const question = 'A reveal still waiting for this account';
    await page.goto(base);
    await page.getByLabel(/What’s on your mind/).fill(question);
    await page.getByRole('button', { name: /Draw Cards/ }).click();
    await page.getByRole('link', { name: /^Journal/ }).click();
    await expect(
      page.getByText('Cloud readings synced. Saved deletions could not be checked.', {
        exact: true,
      }),
    ).toBeVisible();
    const [reading] = await downloadReadings(page, 'Export available readings');
    await page.getByRole('button', { name: /^Open reading:/ }).click();
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Reveal card 2', exact: true }).click();
    await page.getByRole('link', { name: /^Journal/ }).click();
    const expected = { ...reading, revealed: [false, true, false] };
    assert.deepEqual(await downloadReadings(page, 'Download unsynced readings'), [expected]);
    await page.getByRole('button', { name: 'Delete reading: ' + question }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete Reading' }).click();
    await expect(page.getByRole('heading', { name: question })).toHaveCount(0);
    await page.close();
    await context.setOffline(false);
    const reopened = await context.newPage();
    await reopened.goto(base + '/journal');
    await expect(reopened.getByRole('heading', { name: question })).toBeVisible();
    await expect(reopened.getByRole('button', { name: 'Recover unsynced readings' })).toBeVisible();
    assert.deepEqual(await downloadReadings(reopened, 'Export available readings'), [expected]);
  }),
);
