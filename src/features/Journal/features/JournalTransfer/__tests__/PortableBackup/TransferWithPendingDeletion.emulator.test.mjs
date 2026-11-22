import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { expect } from '@playwright/test';
import {
  withApp,
  authenticate,
  downloadReadings,
  chooseReadings,
  importReadings,
  deleteFromJournal,
} from '../../../../../../test/emulator/journalBrowser.mjs';

test(
  'a trusted journal that loses IndexedDB checks imports and labels backups until its saved deletion syncs',
  withApp(async (base, browser) => {
    const profile = await browser.newContext();
    const writer = await profile.newPage();
    await authenticate(base, writer, 'lost-store-' + randomUUID() + '@example.test', randomUUID(), {
      signup: true,
      trust: true,
    });
    const reading = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      question: 'A saved deletion awaiting reconnection',
      cards: [{ cardId: 'major-01', orientation: 'upright' }],
      revealed: [false],
    };
    await importReadings(writer, [reading]);
    await profile.setOffline(true);
    await deleteFromJournal(writer, reading);
    await expect(writer.getByText('Changes waiting to sync.', { exact: true })).toBeVisible();
    await writer.close();
    await profile.setOffline(false);
    const restricted = await profile.newPage();
    await restricted.addInitScript(() => {
      Object.defineProperty(window, 'indexedDB', { value: undefined });
    });
    await restricted.goto(base + '/journal');
    await expect(
      restricted.getByText('Cloud readings synced. Saved deletions could not be checked.'),
    ).toBeVisible();
    await expect(
      restricted.getByRole('button', { name: 'Export journal', exact: true }),
    ).toHaveCount(0);
    await assert.rejects(
      restricted.evaluate(async () => {
        const { observeAccount, exportAccountJournal } = window.kit.journal;
        const uid = await new Promise((resolve) => {
          const stop = observeAccount((user) => {
            stop();
            resolve(user.uid);
          });
        });
        return exportAccountJournal(uid);
      }),
      /check saved deletions/i,
    );
    await expect(
      restricted.getByText(/available readings, which may include readings waiting to be deleted/),
    ).toBeVisible();
    assert.deepEqual(await downloadReadings(restricted, 'Export available readings'), [reading]);
    await expect(restricted.getByRole('link', { name: 'Download backup' })).toHaveAttribute(
      'download',
      /unchecked-deletions/,
    );
    // This tab cannot read the queue directly, but its worker can still see the deletion.
    const incoming = [{ ...reading, question: 'A replacement from a backup' }];
    await chooseReadings(restricted, incoming);
    await expect(
      restricted.getByRole('alert').filter({ hasText: /pending deletion/i }),
    ).toBeVisible({
      timeout: 12_000,
    });
    await expect(restricted.getByRole('dialog')).toHaveCount(0);

    await restricted.evaluate(() => Object.defineProperty(window, 'Worker', { value: undefined }));
    await chooseReadings(restricted, incoming);
    const review = restricted.getByRole('dialog', { name: 'Review journal import' });
    await expect(review.getByText(/saved deletions could not be checked/i)).toBeVisible();
    await review.getByRole('button', { name: 'Cancel' }).click();
    assert.deepEqual(await downloadReadings(restricted, 'Export available readings'), [reading]);

    const reveal = { ...reading, revealed: [true] };
    await restricted.evaluate(async (reveal) => {
      const { observeAccount } = window.kit.journal;
      const { saveRecoveryCopy } = window.kit.readingRecovery;
      const uid = await new Promise((resolve) => {
        const stop = observeAccount((user) => {
          stop();
          resolve(user.uid);
        });
      });
      saveRecoveryCopy(uid, reveal);
      window.dispatchEvent(new Event('focus'));
    }, reveal);
    await restricted.getByRole('button', { name: 'Recover unsynced readings' }).click();
    await expect(review.getByText(/saved deletions could not be checked/i)).toBeVisible();
    await review.getByRole('button', { name: 'Confirm import' }).click();
    await expect(restricted.getByText(/your recovery copies are still available/i)).toBeVisible();
    await restricted.reload();
    assert.deepEqual(await downloadReadings(restricted, 'Download unsynced readings'), [reveal]);
    await restricted.close();
    const restored = await profile.newPage();
    await restored.goto(base + '/journal');
    // The queued deletion must finish before a checked retry can recreate this reading.
    await expect
      .poll(
        () =>
          restored.evaluate(async () => {
            const { observeAccount, exportAccountJournal } = window.kit.journal;
            const uid = await new Promise((resolve) => {
              const stop = observeAccount((user) => {
                stop();
                resolve(user?.uid);
              });
            });
            if (!uid) return null;
            try {
              return JSON.parse(await exportAccountJournal(uid)).readings;
            } catch {
              return null;
            }
          }),
        { timeout: 15_000 },
      )
      .toEqual([]);
    assert.deepEqual(await downloadReadings(restored, 'Download unsynced readings'), [reveal]);
    await restored.getByRole('button', { name: 'Recover unsynced readings' }).click();
    await restored.getByRole('button', { name: 'Confirm import' }).click();
    await expect(restored.getByText('Imported 1 reading.', { exact: true })).toBeVisible();
    await expect(restored.getByRole('button', { name: 'Recover unsynced readings' })).toHaveCount(
      0,
    );
    await restored.reload();
    assert.deepEqual(await downloadReadings(restored, 'Export journal'), [reveal]);
  }),
);
