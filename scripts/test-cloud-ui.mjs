import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { chromium, expect, webkit } from '@playwright/test';
import { createServer } from 'vite';
import { verifyEmulatorEmail } from './emulator-email.mjs';
import { testPortableJournals } from './portable-journal-workflows.mjs';

const withApp =
  (run, browserType = chromium) =>
  async () => {
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
      browser = await browserType.launch();
      await run(base, browser);
    } finally {
      await browser?.close();
      await server.close();
    }
  };

const authenticate = async (
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

const downloadReadings = async (page, button) => {
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: button, exact: true }).click();
  const file = await downloading;
  return JSON.parse(await readFile(await file.path(), 'utf8')).readings;
};

const chooseReadings = (page, readings) =>
  page.getByLabel('Journal backup file').setInputFiles({
    name: 'readings.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ version: 1, readings })),
  });

const importReadings = async (
  page,
  readings,
  expectedStatus = `Imported ${readings.length} ${readings.length === 1 ? 'reading' : 'readings'}.`,
) => {
  await chooseReadings(page, readings);
  await page.getByRole('button', { name: 'Confirm import' }).click();
  await expect(page.getByText(expectedStatus, { exact: true })).toBeVisible();
};

const deleteFromJournal = async (page, reading) => {
  await page.getByRole('button', { name: 'Delete reading: ' + reading.question }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete Reading' }).click();
  await expect(page.getByRole('heading', { name: reading.question })).toHaveCount(0);
};

testPortableJournals({ withApp, authenticate, importReadings, downloadReadings });

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
      const { createReading, observeAccount } = await import('/src/cloud/journal.ts');
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
        const { createReading } = await import('/src/cloud/journal.ts');
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
          const { createReading } = await import('/src/cloud/journal.ts');
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

const retainTabReading = (page, reading) =>
  page.evaluate(async (reading) => {
    const { observeAccount } = await import('/src/cloud/journal.ts');
    const { saveTabRecoveryCopy } = await import('/src/domain/tabRecovery.ts');
    const { retainRecoveryCopies } = await import('/src/domain/readingRecovery.ts');
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
      const { observeAccount, clearReadings, createReading } = await import(
        '/src/cloud/journal.ts'
      );
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
        const { clearReadings } = await import('/src/cloud/journal.ts');
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
    await first.evaluate(() => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (this === localStorage && key === 'stilllight.tarot.v1') {
          Storage.prototype.setItem = setItem;
          throw new DOMException('Guest storage is full', 'QuotaExceededError');
        }
        return setItem.call(this, key, value);
      };
    });
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
    await expect(page.getByRole('alert')).toContainText(/only lock this tab/i);
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
      await expect(page.getByRole('alert')).toHaveCount(2);
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
        const { observeAccount } = await import('/src/cloud/account.ts');
        const { saveTabRecoveryCopy } = await import('/src/domain/tabRecovery.ts');
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
      const { observeAccount } = await import('/src/cloud/account.ts');
      const { saveRecoveryCopy } = await import('/src/domain/readingRecovery.ts');
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
      const { collisionReadingId } = await import('/src/domain/journalBackup.ts');
      return { ...reading, id: await collisionReadingId(reading) };
    }, original);
    await importReadings(reader, [original, assigned]);
    await expect(writer.getByRole('heading', { name: original.question })).toHaveCount(2);

    await writer.evaluate(
      async ({ original, assigned }) => {
        const { observeAccount } = await import('/src/cloud/account.ts');
        const { loadRecoveryCopies, importTargetRecorder, saveRecoveryCopy } = await import(
          '/src/domain/readingRecovery.ts'
        );
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
        const { createReading, exportAccountJournal } = await import('/src/cloud/journal.ts');
        const { saveTabRecoveryCopy } = await import('/src/domain/tabRecovery.ts');
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
            const { observeAccount, exportAccountJournal } = await import('/src/cloud/journal.ts');
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
        const { observeAccount, exportAccountJournal } = await import('/src/cloud/journal.ts');
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
      const { observeAccount } = await import('/src/cloud/journal.ts');
      const { saveRecoveryCopy } = await import('/src/domain/readingRecovery.ts');
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
            const { observeAccount, exportAccountJournal } = await import('/src/cloud/journal.ts');
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
      const { observeAccount } = await import('/src/cloud/account.ts');
      const { saveRecoveryCopy, prepareRecoveryDeletion } = await import(
        '/src/domain/readingRecovery.ts'
      );
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
    await writer.close();
    await context.setOffline(false);
    const reopened = await context.newPage();
    await reopened.goto(base + '/journal');
    await expect(cloudRow).toHaveCount(0);
    await expect
      .poll(() =>
        reopened.evaluate(
          async ({ uid, id }) => {
            const { loadRecoveryCopies } = await import('/src/domain/readingRecovery.ts');
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

test(
  'signing out from another tab preserves an offline reading held only in memory',
  withApp(async (base, browser) => {
    const { context, writer, sibling, email, password, question, expected } =
      await openTabsWithMemoryOnlyWrites(base, browser, true);
    const signOut = sibling.getByRole('button', { name: 'Sign out' });
    await signOut.click();
    await expect(sibling.getByRole('alert')).toContainText(/tab/i);
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

const cacheNames = (page) =>
  page.evaluate(async () =>
    (await indexedDB.databases())
      .map(({ name }) => name)
      .filter((name) => name?.startsWith('firestore/journal-')),
  );
const cachedRows = (page, name, store) =>
  page.evaluate(
    async ({ name, store }) => {
      const database = await new Promise((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onupgradeneeded = () => open.transaction.abort();
        open.onerror = () => reject(open.error);
        open.onsuccess = () => resolve(open.result);
      });
      try {
        return await new Promise((resolve, reject) => {
          const read = database.transaction(store).objectStore(store).getAll();
          read.onerror = () => reject(read.error);
          read.onsuccess = () => resolve(read.result);
        });
      } finally {
        database.close();
      }
    },
    { name, store },
  );
const signOutFromJournal = async (page) => {
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('main').getByRole('link', { name: 'Sign in' })).toBeVisible();
};

test(
  'withdrawing trust retries a blocked removal and erases only the selected cache across a browser restart',
  withApp(async (base) => {
    const directory = await mkdtemp(join(tmpdir(), 'arcana-trust-test-'));
    let profile;
    try {
      profile = await chromium.launchPersistentContext(directory);
      const page = await profile.newPage();
      const email = 'withdraw-' + randomUUID() + '@example.test';
      const password = randomUUID();
      const reading = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        question: 'The other journal stays on this device',
        cards: [{ cardId: 'major-00', orientation: 'upright' }],
        revealed: [true],
      };
      await authenticate(base, page, 'other-' + email, password, { signup: true, trust: true });
      await importReadings(page, [reading]);
      const [otherCache] = await cacheNames(page);
      await signOutFromJournal(page);
      await authenticate(base, page, email, password, { signup: true, trust: true });
      const target = {
        ...reading,
        id: randomUUID(),
        question: 'Remove the offline copy of this reading',
      };
      await importReadings(page, [target]);
      const cache = (await cacheNames(page)).find((name) => name !== otherCache);
      assert.ok(cache && otherCache);
      await signOutFromJournal(page);
      // An older/suspended client can retain an IndexedDB connection after sign-out.
      const sibling = await profile.newPage();
      await sibling.goto(base + '/icon.svg');
      await sibling.evaluate(
        (name) =>
          new Promise((resolve) => {
            const open = indexedDB.open(name);
            open.onsuccess = () => {
              window.heldCache = open.result;
              resolve();
            };
          }),
        cache,
      );
      await authenticate(base, page, email, password);
      await expect(page.getByRole('alert').filter({ hasText: /close those tabs/i })).toBeVisible();
      await page.reload();
      const retry = page.getByRole('button', { name: 'Retry offline journal removal' });
      await expect(retry).toBeVisible();
      await sibling.close();
      await page.evaluate((cacheName) => {
        const open = indexedDB.open.bind(indexedDB);
        indexedDB.open = (name, ...args) => {
          if (name === cacheName) {
            indexedDB.open = open;
            throw new Error('Opening this cache was denied');
          }
          return open(name, ...args);
        };
      }, cache);
      await retry.click();
      await expect(
        page.getByRole('alert').filter({ hasText: /allow browser storage access/i }),
      ).toBeVisible();
      assert.ok((await cacheNames(page)).includes(cache));
      await retry.click();
      await expect(retry).toHaveCount(0);
      assert.deepEqual(await downloadReadings(page, 'Export journal'), [target]);
      assert.deepEqual(await cacheNames(page), [otherCache]);
      await profile.close();
      profile = await chromium.launchPersistentContext(directory);
      const reopened = await profile.newPage();
      await reopened.goto(base + '/journal');
      await expect(reopened.getByRole('main').getByRole('link', { name: 'Sign in' })).toBeVisible();
      assert.deepEqual(await cacheNames(reopened), [otherCache]);
      assert.ok(
        JSON.stringify(await cachedRows(reopened, otherCache, 'remoteDocumentsV14')).includes(
          reading.question,
        ),
      );
    } finally {
      await profile?.close();
      const path = resolve(directory);
      assert.equal(dirname(path), resolve(tmpdir()));
      assert.ok(basename(path).startsWith('arcana-trust-test-'));
      await rm(path, { recursive: true, force: true });
    }
  }),
);

test(
  'withdrawing trust keeps an offline draw queued in Firestore until the owner syncs it',
  withApp(async (base, browser) => {
    const profile = await browser.newContext();
    const writer = await profile.newPage();
    const email = 'withdraw-queue-' + randomUUID() + '@example.test';
    const password = randomUUID();
    await authenticate(base, writer, email, password, { signup: true, trust: true });
    const [cache] = await cacheNames(writer);
    await writer.goto(base);
    await expect(writer.getByLabel(/What’s on your mind/)).toBeVisible();
    // A full Web Storage quota leaves Firestore as the only durable copy.
    await writer.evaluate(() => {
      const save = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (this === localStorage && key.startsWith('arcana.journal.recovery.'))
          throw new DOMException('Full', 'QuotaExceededError');
        return save.call(this, key, value);
      };
    });
    await profile.setOffline(true);
    const question = 'Keep my offline draw through device trust withdrawal';
    await writer.getByLabel(/What’s on your mind/).fill(question);
    await writer.getByRole('button', { name: /Draw Cards/ }).click();
    await expect
      .poll(async () => (await cachedRows(writer, cache, 'mutations')).length)
      .toBeGreaterThan(0);
    await writer.close();
    await profile.setOffline(false);
    const page = await profile.newPage();
    // Model an expired/removed login on reopening. Leave the cached SDK write intact.
    await page.goto(base + '/icon.svg');
    await page.evaluate(() => {
      const key = Object.keys(localStorage).find((key) => key.startsWith('firebase:authUser:'));
      if (!key) throw new Error('Trusted login missing from test fixture');
      localStorage.removeItem(key);
    });
    await authenticate(base, page, email, password);
    await expect(page.getByRole('alert').filter({ hasText: /sync or recover/i })).toBeVisible();
    await page.getByRole('button', { name: 'Retry offline journal removal' }).click();
    assert.ok((await cachedRows(page, cache, 'mutations')).length);
    await signOutFromJournal(page);
    await authenticate(base, page, email, password, { trust: true });
    await expect(page.getByRole('heading', { name: question })).toBeVisible();
    await expect.poll(async () => (await cachedRows(page, cache, 'mutations')).length).toBe(0);
    await signOutFromJournal(page);
    await authenticate(base, page, email, password);
    assert.deepEqual(await cacheNames(page), []);
    const exported = await downloadReadings(page, 'Export journal');
    assert.deepEqual(
      exported.map(({ question }) => question),
      [question],
    );
  }),
);

test(
  'a restored memory-only session checks legacy caches and preserves a later trusted grant until confirmed',
  withApp(async (base, browser) => {
    const profile = await browser.newContext();
    const session = await profile.newPage();
    const email = 'restored-opt-out-' + randomUUID() + '@example.test';
    const password = randomUUID();
    await authenticate(base, session, email, password, { signup: true });
    await session.reload();
    await expect(session.getByRole('heading', { name: email })).toBeVisible();
    const trusted = await profile.newPage();
    await authenticate(base, trusted, email, password, { trust: true });
    const reading = {
      id: randomUUID(),
      question: 'A newer trusted journal',
      createdAt: new Date().toISOString(),
      cards: [{ cardId: 'major-00', orientation: 'upright' }],
      revealed: [false],
    };
    await importReadings(trusted, [reading]);
    const [cache] = await cacheNames(trusted);
    assert.ok(cache);
    await signOutFromJournal(trusted);
    await session.reload();
    await expect(session.getByRole('heading', { name: reading.question })).toBeVisible();
    const retry = session.getByRole('button', { name: 'Retry offline journal removal' });
    await expect(retry).toHaveCount(0);
    assert.deepEqual(await cacheNames(session), [cache]);

    // Older session credentials predate offline-removal receipts. Reopening
    // must surface the existing cache without assuming it predates this login.
    await session.evaluate(() => {
      const receipt = Object.keys(sessionStorage).find((key) =>
        key.startsWith('arcana.journal.offline-removal:'),
      );
      if (!receipt) throw new Error('Memory-only login receipt missing');
      sessionStorage.removeItem(receipt);
    });
    await session.reload();
    await expect(
      session.getByRole('alert').filter({ hasText: /offline journal from a trusted sign-in/i }),
    ).toBeVisible();
    assert.deepEqual(await cacheNames(session), [cache]);
    // Policy can change after the cache has been opened. A synchronous
    // deletion error must release its handle and allow a subsequent retry.
    await session.evaluate((cache) => {
      const remove = indexedDB.deleteDatabase.bind(indexedDB);
      indexedDB.deleteDatabase = (name) => {
        if (name === cache) {
          indexedDB.deleteDatabase = remove;
          throw new DOMException('Blocked', 'SecurityError');
        }
        return remove(name);
      };
    }, cache);
    await retry.click();
    await expect(
      session.getByRole('alert').filter({ hasText: /allow browser storage access/i }),
    ).toBeVisible();
    await retry.click();
    await expect(retry).toHaveCount(0);
    assert.deepEqual(await cacheNames(session), []);
    assert.deepEqual(await downloadReadings(session, 'Export journal'), [reading]);
  }),
);

test(
  'retrying offline removal keeps account recovery hidden until the verification token can be checked',
  withApp(async (base, browser) => {
    const page = await browser.newPage();
    const email = 'retry-token-' + randomUUID() + '@example.test';
    await authenticate(base, page, email, randomUUID(), { signup: true });
    await page.evaluate(() => {
      const key = Object.keys(sessionStorage).find((key) => key.startsWith('firebase:authUser:'));
      const record = JSON.parse(sessionStorage.getItem(key));
      record.stsTokenManager.expirationTime = Date.now() - 1000;
      sessionStorage.setItem(key, JSON.stringify(record));
      sessionStorage.removeItem('arcana.journal.offline-removal:' + record.uid);
      localStorage.setItem(
        'arcana.journal.recovery.v1:' + record.uid + ':' + crypto.randomUUID(),
        JSON.stringify({
          id: crypto.randomUUID(),
          question: 'Private pending reading',
          createdAt: new Date().toISOString(),
          cards: [{ cardId: 'major-00', orientation: 'upright' }],
          revealed: [false],
        }),
      );
    });
    const authRequests = 'http://127.0.0.1:9099/**';
    await page.route(authRequests, (route) => route.abort('internetdisconnected'));
    await page.reload();
    const guest = page.getByText('Your readings are saved in the guest journal on this device.');
    const retry = page.getByRole('button', { name: 'Retry offline journal removal' });
    const recover = page.getByRole('button', { name: 'Recover unsynced readings' });
    await expect(guest).toBeVisible();
    await expect(recover).toHaveCount(0);
    await retry.click();
    await expect(retry).toBeEnabled();
    await expect(guest).toBeVisible();
    await expect(recover).toHaveCount(0);
    await page.unroute(authRequests);
    await page.getByRole('button', { name: 'Check verification' }).click();
    await expect(recover).toBeVisible();
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
    await expect(reopened.getByRole('alert')).toContainText(/connect to the internet/i);
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
    await expect(reopened.getByRole('alert')).toBeVisible();
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
