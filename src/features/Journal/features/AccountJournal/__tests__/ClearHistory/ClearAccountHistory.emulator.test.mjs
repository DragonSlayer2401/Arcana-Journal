import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
  'a two-browser clear keeps later draws and reused IDs after deleting its first page',
  { timeout: 60000 },
  withApp(async (base, browser) => {
    const first = await browser.newPage();
    const second = await browser.newPage();
    const email = 'confirmed-clear-' + randomUUID() + '@example.test';
    const password = randomUUID();
    await authenticate(base, first, email, password, { signup: true });
    await authenticate(base, second, email, password);
    const hash = (id) => createHash('sha256').update(id).digest('hex');
    const archive = Array.from({ length: 103 }, (_, i) => ({
      id: 'archive-' + i,
      createdAt: '2026-01-02T10:00:00.000Z',
      question: 'Archived reading ' + i,
      cards: [{ cardId: 'major-00', orientation: 'upright' }],
      revealed: [false],
    })).sort((a, b) => hash(a.id).localeCompare(hash(b.id)));
    const uid = await second.evaluate(async (archive) => {
      const { createReading, observeAccount } = window.kit.journal;
      const uid = await new Promise((resolve) => {
        const stop = observeAccount((user) => {
          stop();
          resolve(user.uid);
        });
      });
      await Promise.all(archive.map((reading) => createReading(uid, reading)));
      return uid;
    }, archive);
    await expect(first.getByRole('button', { name: 'Load older readings' })).toBeVisible();
    await first.getByRole('button', { name: 'Clear History' }).click();
    const confirm = first.getByRole('dialog').getByRole('button', { name: 'Clear All Readings' });
    await expect(confirm).toBeEnabled();
    await expect(first.getByRole('dialog')).toContainText('103 synced readings');
    const afterReview = {
      ...archive[0],
      id: randomUUID(),
      question: 'Saved while the confirmation was open',
    };
    await second.evaluate(
      async ({ uid, reading }) => {
        const { createReading } = window.kit.journal;
        await createReading(uid, reading);
      },
      { uid, reading: afterReview },
    );
    assert.equal((await downloadReadings(second, 'Export journal')).length, 104);
    const previousBackup = second.getByRole('link', { name: 'Download backup' });
    await second.context().setOffline(true);
    await expect(previousBackup).toBeVisible();

    const committed = Promise.withResolvers();
    const release = Promise.withResolvers();
    let firstPage = true;
    await first.route('**/documents:commit*', async (route) => {
      const deletions = route
        .request()
        .postDataJSON()
        ?.writes?.filter((write) => write.delete);
      if (!firstPage || !deletions?.length) return route.continue();
      firstPage = false;
      const response = await route.fetch();
      committed.resolve({ status: response.status(), count: deletions.length });
      await release.promise;
      await route.fulfill({ response });
    });
    try {
      await confirm.click();
      await expect.poll(() => firstPage, { timeout: 10000 }).toBe(false);
      assert.deepEqual(await committed.promise, { status: 200, count: 100 });
      await second.context().setOffline(false);
      await expect(previousBackup).toHaveCount(0, { timeout: 20000 });
      // Place the new draw beyond the old hash cursor so a moving scan would
      // always delete it. The spread and its server write follow the normal UI.
      let lateId;
      do {
        lateId = randomUUID();
      } while (hash(lateId) < hash(archive[99].id));
      await second.goto(base);
      await second.getByLabel(/What’s on your mind/).fill('Drawn after the first page cleared');
      await second.evaluate((id) => {
        const original = crypto.randomUUID.bind(crypto);
        crypto.randomUUID = () => {
          crypto.randomUUID = original;
          return id;
        };
      }, lateId);
      await second.getByRole('button', { name: /Draw Cards/ }).click();
      await second.getByRole('link', { name: /^Journal/ }).click();
      await expect(
        second.getByRole('heading', { name: 'Drawn after the first page cleared' }),
      ).toBeVisible();
      for (const original of archive.slice(100, 102)) await deleteFromJournal(second, original);
      await expect(second.getByRole('button', { name: 'Sign out' })).toBeEnabled();
      const replaced = { ...archive[100], question: 'New spread at an old ID' };
      const recreated = archive[101];
      await second.evaluate(
        async ({ uid, readings }) => {
          const { createReading } = window.kit.journal;
          await Promise.all(readings.map((reading) => createReading(uid, reading)));
        },
        { uid, readings: [replaced, recreated] },
      );
      const checkedExport = second.getByRole('button', { name: 'Export journal', exact: true });
      if (await checkedExport.isVisible()) await checkedExport.click();
      const before = await downloadReadings(second, 'Export available readings');
      const late = before.find((r) => r.id === lateId);
      assert.ok(late, 'The draw from browser B must be on the server');
      release.resolve();
      await expect(first.getByRole('button', { name: 'Sign out' })).toBeEnabled();
      const remaining = await downloadReadings(first, 'Export journal');
      await expect(previousBackup).toHaveCount(0);
      assert.deepEqual(
        remaining.sort((a, b) => a.id.localeCompare(b.id)),
        [afterReview, replaced, recreated, late].sort((a, b) => a.id.localeCompare(b.id)),
      );
    } finally {
      release.resolve();
    }
  }),
);

for (const scenario of ['stays open', 'closes', 'registers from a separate browser']) {
  const closeWriter = scenario === 'closes';
  const separateBrowser = scenario === 'registers from a separate browser';
  test(
    `a checked recovery survives an earlier bulk clear when its tab ${scenario}`,
    withApp(async (base, browser) => {
      const profile = await browser.newContext();
      const session = await profile.newPage();
      const email = 'recover-during-clear-' + randomUUID() + '@example.test';
      const password = randomUUID();
      await authenticate(base, session, email, password, { signup: true });
      await session.reload();
      const reading = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        question: 'Keep the reading I recovered',
        cards: [{ cardId: 'major-00', orientation: 'upright' }],
        revealed: [true],
      };
      await importReadings(session, [reading]);
      const writer = separateBrowser ? await browser.newPage() : await profile.newPage();
      await authenticate(base, writer, email, password, { trust: true });
      const uid = await retainTabReading(session, reading);
      if (separateBrowser) {
        const marker = await profile.request.get(
          'http://127.0.0.1:8080/v1/projects/demo-arcana-journal/databases/(default)/documents/users/' +
            uid +
            '/journalOperations/clear',
          { headers: { Authorization: 'Bearer owner' } },
        );
        assert.equal(
          marker.status(),
          404,
          'An ordinary file import must not create a clear marker',
        );
      }
      // Separate profiles share only the server. Hold the initial registration
      // there, or a submitted delete page when both tabs share browser storage.
      const reached = Promise.withResolvers();
      const released = Promise.withResolvers();
      const timeout = setTimeout(
        () => reached.reject(new Error('Clear History did not submit its expected operation.')),
        15000,
      );
      await writer.route('**/documents:commit*', async (route) => {
        const request = route.request();
        if (
          !request
            .postDataJSON()
            ?.writes?.some((write) =>
              separateBrowser
                ? write.update?.name?.endsWith('/journalOperations/clear')
                : write.delete?.includes('/readings/'),
            )
        )
          return route.continue();
        const submitted = {
          url: request.url(),
          headers: await request.allHeaders(),
          data: request.postData(),
        };
        // Model a request still in transit after the tab loses its connection.
        // Detaching Playwright from a paused Chromium request can otherwise
        // forward it on close, before the recovering tab has confirmed.
        if (closeWriter) await route.abort('connectionreset');
        reached.resolve(submitted);
        if (closeWriter) return;
        await released.promise;
        if (!writer.isClosed()) await route.continue();
      });
      try {
        await writer.getByRole('button', { name: 'Clear History' }).click();
        await writer
          .getByRole('dialog')
          .getByRole('button', { name: 'Clear All Readings' })
          .click();
        const request = await reached.promise;
        if (closeWriter) await writer.close();
        await session.getByRole('button', { name: 'Recover unsynced readings' }).click();
        await session.getByRole('dialog').getByRole('button', { name: 'Confirm import' }).click();
        await expect(session.getByText(/Skipped 1 reading already in your journal/)).toBeVisible();
        await expect(
          session.getByRole('button', { name: 'Recover unsynced readings' }),
        ).toHaveCount(0);
        released.resolve();
        if (closeWriter) {
          const response = await profile.request.post(request.url, {
            headers: request.headers,
            data: request.data,
          });
          assert.equal(
            response.ok(),
            false,
            'The previously submitted delete must fail its precondition',
          );
        } else await expect(writer.getByRole('button', { name: 'Sign out' })).toBeEnabled();
        assert.deepEqual(await downloadReadings(session, 'Export journal'), [reading]);
        if (!closeWriter)
          await expect(
            writer.getByText(/review the remaining readings and confirm again/i),
          ).toBeVisible();
      } finally {
        clearTimeout(timeout);
        released.resolve();
      }
    }),
  );
}

test(
  'recovery supersedes a confirmed clear checking a reading outside its first journal page',
  withApp(async (base, browser) => {
    const profile = await browser.newContext();
    const session = await profile.newPage();
    const email = 'clear-preparation-' + randomUUID() + '@example.test';
    const password = randomUUID();
    await authenticate(base, session, email, password, { signup: true });
    await session.reload();
    const reading = {
      id: randomUUID(),
      question: 'Preserve my recovered reading',
      createdAt: new Date().toISOString(),
      cards: [{ cardId: 'major-01', orientation: 'upright' }],
      revealed: [true],
    };
    await importReadings(session, [reading]);
    const writer = await profile.newPage();
    await authenticate(base, writer, email, password, { trust: true });
    const uid = await retainTabReading(session, reading);
    const { missingHash, cloudBefore } = await writer.evaluate(
      async ({ uid, reading }) => {
        const { createReading, exportAccountJournal } = window.kit.journal;
        const { saveTabRecoveryCopy } = window.kit;
        await Promise.all(
          Array.from({ length: 51 }, (_, index) =>
            createReading(uid, {
              ...reading,
              id: crypto.randomUUID(),
              question: 'Archived ' + index,
            }),
          ),
        );
        const cloudBefore = JSON.parse(await exportAccountJournal(uid)).readings;
        const missing = crypto.randomUUID();
        saveTabRecoveryCopy(uid, { ...reading, id: missing, question: 'A local-only reading' });
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(missing));
        const missingHash = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('');
        return { cloudBefore, missingHash };
      },
      { uid, reading },
    );
    await expect(writer.getByRole('button', { name: 'Load older readings' })).toBeVisible();

    // Delay only the lookup of this local copy's destination, reached after the
    // owner confirms Clear All Readings but before any page can be deleted.
    let checking = false;
    const release = Promise.withResolvers();
    await writer.route('http://127.0.0.1:8080/**', async (route) => {
      const request = route.request();
      if (!(request.postData() ?? '').includes(missingHash) && !request.url().includes(missingHash))
        return route.continue();
      checking = true;
      await release.promise;
      await route.continue();
    });
    try {
      await writer.getByRole('button', { name: 'Clear History' }).click();
      await writer.getByRole('dialog').getByRole('button', { name: 'Clear All Readings' }).click();
      await expect.poll(() => checking).toBe(true);
      await session.getByRole('button', { name: 'Recover unsynced readings' }).click();
      await session.getByRole('button', { name: 'Confirm import' }).click();
      await expect(session.getByText(/Skipped 1 reading already in your journal/)).toBeVisible();
      await expect(session.getByRole('button', { name: 'Recover unsynced readings' })).toHaveCount(
        0,
      );
      release.resolve();
      await expect(
        writer.getByText(/review the remaining readings and confirm again/i),
      ).toBeVisible();
      const unsynced = await downloadReadings(writer, 'Download unsynced readings');
      assert.deepEqual(
        unsynced.map((row) => row.question),
        ['A local-only reading'],
      );
      await writer.close();
      assert.equal(cloudBefore.length, 52);
      assert.deepEqual(await downloadReadings(session, 'Export journal'), cloudBefore);
    } finally {
      release.resolve();
    }
  }),
);
