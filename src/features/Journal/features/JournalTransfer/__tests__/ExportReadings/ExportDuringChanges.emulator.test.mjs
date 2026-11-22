import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { expect } from '@playwright/test';
import {
  withApp,
  authenticate,
  downloadReadings,
  importReadings,
  deleteFromJournal,
  retainTabReading,
} from '../../../../../../test/emulator/journalBrowser.mjs';

test(
  'a closed tab with a submitted bulk clear requires an explicitly labeled export',
  { timeout: 30000 },
  withApp(async (base, browser) => {
    const profile = await browser.newContext();
    const session = await profile.newPage();
    const email = 'export-pending-clear-' + randomUUID() + '@example.test';
    const password = randomUUID();
    await authenticate(base, session, email, password, { signup: true });
    await session.reload();
    const reading = {
      id: randomUUID(),
      question: 'Selected for bulk deletion',
      createdAt: new Date().toISOString(),
      cards: [{ cardId: 'major-01', orientation: 'upright' }],
      revealed: [true],
    };
    await importReadings(session, [reading]);
    const writer = await profile.newPage();
    await authenticate(base, writer, email, password, { trust: true });
    const outgoing = Promise.withResolvers();
    let submitted = false;
    await writer.route('**/documents:commit*', async (route) => {
      const request = route.request();
      if (request.postDataJSON()?.writes?.some((write) => write.delete?.includes('/readings/'))) {
        submitted = true;
        outgoing.resolve({
          url: request.url(),
          headers: await request.allHeaders(),
          data: request.postData(),
        });
      }
      // The tab loses connectivity after sending this page. Its attempted
      // cleanup cannot reach the server, including if it runs before close.
      if (submitted) await route.abort('connectionreset');
      else await route.continue();
    });
    await writer.getByRole('button', { name: 'Clear History' }).click();
    await writer.getByRole('dialog').getByRole('button', { name: 'Clear All Readings' }).click();
    const pending = await outgoing.promise;
    await writer.close();
    const downloads = [];
    session.on('download', (download) => downloads.push(download.suggestedFilename()));
    const normal = session.getByRole('button', { name: 'Export journal', exact: true });
    if (await normal.isVisible()) await normal.click();
    const available = session.getByRole('button', {
      name: 'Export available readings',
      exact: true,
    });
    await expect(available).toBeVisible();
    assert.deepEqual(downloads, []);
    const downloading = session.waitForEvent('download', { timeout: 5000 });
    await available.click();
    const file = await downloading;
    assert.match(file.suggestedFilename(), /unchecked-deletions/);
    assert.deepEqual(JSON.parse(await readFile(await file.path(), 'utf8')).readings, [reading]);

    // The clearing tab may never come back. The owner can still explicitly
    // recover, and that confirmation invalidates the delayed delete.
    await retainTabReading(session, reading);
    await session.getByRole('button', { name: 'Recover unsynced readings' }).click();
    await session.getByRole('dialog').getByRole('button', { name: 'Confirm import' }).click();
    await expect(session.getByText(/Skipped 1 reading already in your journal/)).toBeVisible();
    await expect(session.getByRole('button', { name: 'Recover unsynced readings' })).toHaveCount(0);
    const late = await profile.request.post(pending.url, {
      headers: pending.headers,
      data: pending.data,
    });
    assert.equal(late.ok(), false);
    assert.deepEqual(await downloadReadings(session, 'Export journal'), [reading]);
  }),
);

test(
  'a clear that finishes during a paged export requires a fresh backup',
  { timeout: 30000 },
  withApp(async (base, browser) => {
    const reader = await browser.newPage();
    const writer = await browser.newPage();
    const email = 'clear-during-export-' + randomUUID() + '@example.test';
    const password = randomUUID();
    await authenticate(base, reader, email, password, { signup: true });
    await authenticate(base, writer, email, password);
    const uid = await writer.evaluate(async () => {
      const { observeAccount, clearReadings, createReading } = window.kit.journal;
      const uid = await new Promise((resolve) => {
        const stop = observeAccount((user) => {
          stop();
          resolve(user.uid);
        });
      });
      // Both export checks will see an inactive control. Its revision records
      // that a complete clear ran between pages.
      await clearReadings(uid);
      await Promise.all(
        Array.from({ length: 101 }, (_, i) =>
          createReading(uid, {
            id: 'paged-' + i,
            question: 'Reading ' + i,
            createdAt: '2026-01-02T10:00:00Z',
            cards: [{ cardId: 'major-00', orientation: 'upright' }],
            revealed: [false],
          }),
        ),
      );
      return uid;
    });
    await reader.evaluate((uid) => {
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      const gate = Promise.withResolvers();
      window.releaseBackupPage = gate.resolve;
      crypto.subtle.digest = async (algorithm, data) => {
        const value = new TextDecoder().decode(data);
        if (value.startsWith('[' + JSON.stringify(uid) + ',"paged-')) {
          crypto.subtle.digest = digest;
          window.receivedBackupPage = true;
          await gate.promise;
        }
        return digest(algorithm, data);
      };
    }, uid);
    const downloads = [];
    reader.on('download', (file) => downloads.push(file.suggestedFilename()));
    await reader.getByRole('button', { name: 'Export journal', exact: true }).click();
    await reader.waitForFunction(() => window.receivedBackupPage, undefined, { timeout: 5000 });
    try {
      await writer.evaluate(async (uid) => {
        const { clearReadings } = window.kit.journal;
        await clearReadings(uid);
      }, uid);
    } finally {
      await reader.evaluate(() => window.releaseBackupPage());
    }
    await expect(
      reader.getByText(/journal changed while the backup was being prepared/i),
    ).toBeVisible();
    assert.deepEqual(downloads, []);
    assert.deepEqual(await downloadReadings(reader, 'Export journal'), []);
  }),
);

for (const mixedLocks of [false, true])
  test(
    'full export detects recovery held only in an idle sibling tab' +
      (mixedLocks ? ' with mixed Web Locks access' : ''),
    withApp(async (base, browser) => {
      const context = await browser.newContext();
      const writer = await context.newPage();
      if (mixedLocks)
        await writer.addInitScript(() => {
          Object.defineProperty(navigator, 'locks', { value: undefined });
        });
      const sibling = await context.newPage();
      await authenticate(
        base,
        writer,
        'backup-tabs-' + randomUUID() + '@example.test',
        randomUUID(),
        {
          signup: true,
          trust: true,
        },
      );
      await sibling.goto(base + '/journal');
      await expect(sibling.getByText('Journal synced.', { exact: true })).toBeVisible();
      const reading = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        question: 'A recovery copy in the original tab',
        cards: [{ cardId: 'major-01', orientation: 'upright' }],
        revealed: [true],
      };
      await writer.evaluate(async (reading) => {
        const { observeAccount } = window.kit.journal;
        const { saveTabRecoveryCopy } = window.kit;
        const uid = await new Promise((resolve) => {
          const stop = observeAccount((user) => {
            stop();
            resolve(user.uid);
          });
        });
        saveTabRecoveryCopy(uid, reading);
      }, reading);
      await expect(writer.getByRole('button', { name: 'Recover unsynced readings' })).toBeVisible();
      await sibling.getByRole('button', { name: 'Export journal' }).click();
      await expect(sibling.getByText(/another tab has unsynced journal changes/i)).toBeVisible();
      await expect(sibling.getByRole('link', { name: 'Download backup' })).toHaveCount(0);
      assert.deepEqual(await downloadReadings(writer, 'Export journal'), [reading]);
      writer.once('dialog', (dialog) => dialog.accept());
      await writer.getByRole('button', { name: 'Discard recovery copies' }).click();
      await expect(writer.getByRole('button', { name: 'Recover unsynced readings' })).toHaveCount(
        0,
      );
      assert.deepEqual(await downloadReadings(sibling, 'Export journal'), []);
    }),
  );

test(
  'a session-only export waits for its trusted deletion after the writer closes',
  withApp(async (base, browser) => {
    const profile = await browser.newContext();
    const email = 'session-export-' + randomUUID() + '@example.test';
    const password = randomUUID();
    const other = await profile.newPage();
    await authenticate(base, other, 'other-' + email, password, { signup: true });
    await other.reload();
    await expect(other.getByRole('heading', { name: 'other-' + email })).toBeVisible();
    const reader = await profile.newPage();
    await authenticate(base, reader, email, password, { signup: true });
    await reader.reload();
    await expect(reader.getByRole('heading', { name: email })).toBeVisible();
    const writer = await profile.newPage();
    await authenticate(base, writer, email, password, { trust: true });
    const reading = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      question: 'Do not back up this deleted reading',
      cards: [{ cardId: 'major-01', orientation: 'upright' }],
      revealed: [true],
    };
    await importReadings(writer, [reading]);
    await expect(reader.getByRole('heading', { name: reading.question })).toBeVisible();
    await expect(reader.getByRole('button', { name: 'Lock journal' })).toHaveCount(0);
    await profile.setOffline(true);
    await deleteFromJournal(writer, reading);
    await expect(writer.getByText('Changes waiting to sync.', { exact: true })).toBeVisible();
    await writer.close();
    await profile.setOffline(false);

    // The other account shares this origin but must neither open a persistent
    // queue of its own nor replay the writer's still-pending request.
    assert.deepEqual(await downloadReadings(other, 'Export journal'), []);
    const ownersWithQueues = await other.evaluate(
      async () =>
        (await indexedDB.databases()).filter(({ name }) =>
          name?.startsWith('arcana.journal.deletions.v1:'),
        ).length,
    );
    assert.equal(ownersWithQueues, 1);
    await reader.getByRole('button', { name: 'Export journal', exact: true }).click();
    await expect(
      reader.getByRole('alert').filter({ hasText: /deletion is still waiting to sync/i }),
    ).toBeVisible();
    await expect(reader.getByRole('link', { name: 'Download backup' })).toHaveCount(0);

    const reopened = await profile.newPage();
    await reopened.goto(base + '/journal');
    await expect(reopened.getByRole('button', { name: 'Lock journal' })).toBeVisible();
    await expect(reader.getByRole('heading', { name: reading.question })).toHaveCount(0);
    await expect(reopened.getByText('Journal synced.', { exact: true })).toBeVisible();
    assert.deepEqual(await downloadReadings(reader, 'Export journal'), []);
  }),
);

for (const reservation of ['worker lock', 'legacy IndexedDB']) {
  test(
    `a checked export detects a sibling session's memory-only deletion using its ${reservation}`,
    withApp(async (base, browser) => {
      const profile = await browser.newContext();
      const writer = await profile.newPage();
      const reader = await profile.newPage();
      await writer.addInitScript((mode) => {
        Object.defineProperty(navigator, 'locks', { value: undefined });
        Object.defineProperty(window, 'BroadcastChannel', { value: undefined });
        if (mode === 'legacy IndexedDB')
          Object.defineProperty(window, 'Worker', { value: undefined });
      }, reservation);
      const email = 'volatile-export-' + randomUUID() + '@example.test';
      const password = randomUUID();
      await authenticate(base, writer, email, password, { signup: true });
      await writer.reload();
      await authenticate(base, reader, email, password);
      if (reservation === 'legacy IndexedDB')
        await reader.evaluate(() =>
          Object.defineProperty(indexedDB, 'databases', { value: undefined }),
        );
      const reading = {
        id: randomUUID(),
        question: 'Remove this reading from my journal',
        createdAt: new Date().toISOString(),
        cards: [{ cardId: 'major-01', orientation: 'upright' }],
        revealed: [true],
      };
      await importReadings(reader, [reading]);
      await expect(writer.getByRole('heading', { name: reading.question })).toBeVisible();
      let submitted = false;
      const release = Promise.withResolvers();
      await writer.route('**/documents:commit*', async (route) => {
        if (
          !route
            .request()
            .postDataJSON()
            ?.writes?.some((w) => w.delete?.includes('/readings/'))
        )
          return route.continue();
        submitted = true;
        await release.promise;
        await route.continue();
      });
      try {
        await deleteFromJournal(writer, reading);
        await expect.poll(() => submitted).toBe(true);
        await reader.getByRole('button', { name: 'Export journal', exact: true }).click();
        await expect(
          reader.getByRole('alert').filter({ hasText: /deletion is still waiting to sync/i }),
        ).toBeVisible();
        await expect(reader.getByRole('link', { name: 'Download backup' })).toHaveCount(0);
        await assert.rejects(
          reader.evaluate(async () => {
            const { observeAccount, exportAccountJournal } = window.kit.journal;
            const uid = await new Promise((resolve) => {
              const stop = observeAccount((user) => {
                stop();
                resolve(user.uid);
              });
            });
            return exportAccountJournal(uid, true);
          }),
          /deletion is still waiting to sync/i,
        );
        release.resolve();
        await expect(reader.getByRole('heading', { name: reading.question })).toHaveCount(0);
        await expect(writer.getByText('Journal synced.', { exact: true })).toBeVisible();
        assert.deepEqual(await downloadReadings(reader, 'Export journal'), []);
      } finally {
        release.resolve();
      }
    }),
  );
}

for (const blocked of ['saved deletions', 'in-memory deletions']) {
  test(
    `a session-only export requires an explicit limited backup if it cannot check ${blocked}`,
    withApp(async (base, browser) => {
      const page = await browser.newPage();
      const email = 'unchecked-export-' + randomUUID() + '@example.test';
      await authenticate(base, page, email, randomUUID(), { signup: true });
      const reading = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        question: 'An available cloud reading',
        cards: [{ cardId: 'major-02', orientation: 'upright' }],
        revealed: [false],
      };
      await importReadings(page, [reading]);
      const enable = await page.evaluateHandle((blocked) => {
        const target = blocked === 'saved deletions' ? window : navigator;
        const name = blocked === 'saved deletions' ? 'indexedDB' : 'locks';
        const before = Object.getOwnPropertyDescriptor(target, name);
        const previousWorker = window.Worker;
        Object.defineProperty(target, name, { value: undefined, configurable: true });
        Object.defineProperty(window, 'Worker', { value: undefined, configurable: true });
        return () => {
          if (before) Object.defineProperty(target, name, before);
          else Reflect.deleteProperty(target, name);
          Object.defineProperty(window, 'Worker', { value: previousWorker, configurable: true });
        };
      }, blocked);
      await page.getByRole('button', { name: 'Export journal', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Export available readings' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Download backup' })).toHaveCount(0);
      assert.deepEqual(await downloadReadings(page, 'Export available readings'), [reading]);
      await expect(page.getByRole('link', { name: 'Download backup' })).toHaveAttribute(
        'download',
        /unchecked-deletions/,
      );
      await enable.evaluate((restore) => restore());
      await enable.dispose();
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(page.getByRole('button', { name: 'Export journal', exact: true })).toBeVisible();
      assert.deepEqual(await downloadReadings(page, 'Export journal'), [reading]);
      await expect(page.getByRole('link', { name: 'Download backup' })).toHaveAttribute(
        'download',
        /^arcana-journal-cloud-and-this-tab-\d{4}/,
      );
    }),
  );
}
