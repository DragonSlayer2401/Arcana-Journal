import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { verifyEmulatorEmail } from './emulator-email.mjs';

// Run with the Auth and Firestore emulators for demo-arcana-journal. The
// fixture loads the production SDK adapter in isolated, real browser profiles.
let server;
let browser;
let base;
const harness = '/journal-emulator-test.js';
before(async () => {
  const response = await fetch('http://127.0.0.1:4400/emulators');
  const emulators = await response.json();
  assert.equal(emulators.firestore.port, 8080);
  assert.equal(emulators.auth.port, 9099);
  server = await createServer({
    configFile: false,
    cacheDir: 'node_modules/.vite-journal-tests',
    mode: 'emulator',
    logLevel: 'warn',
    server: { host: '127.0.0.1', port: 0, hmr: false },
    optimizeDeps: { include: ['firebase/app', 'firebase/auth', 'firebase/firestore'] },
    plugins: [
      {
        name: 'journal-emulator-test',
        configureServer(vite) {
          vite.middlewares.use('/test', (_request, response) => {
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><title>Journal emulator test</title>');
          });
        },
        resolveId: (id) => (id === harness ? id : undefined),
        load: (id) =>
          id === harness
            ? [
                "export * as journal from '/src/cloud/journal.ts';",
                "export { databaseFor } from '/src/cloud/account.ts';",
                "export { getAuth } from 'firebase/auth';",
                "export * as firestore from 'firebase/firestore';",
              ].join('\n')
            : undefined,
      },
    ],
  });
  await server.listen();
  base = 'http://127.0.0.1:' + server.httpServer.address().port;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await server?.close();
});

const loadHarness = async (page) => {
  await page.goto(base + '/test');
  await page.evaluate(async (path) => {
    window.kit = await import(path);
    window.observeUser = () =>
      new Promise((resolve) => {
        const stop = window.kit.journal.observeAccount((user) => {
          stop();
          resolve(user);
        });
      });
  }, harness);
  return page;
};
const open = async (context) => loadHarness(await context.newPage());

const entry = (id) => ({
  id,
  createdAt: '2026-01-02T10:00:00.000Z',
  question: 'Original question',
  cards: [
    { cardId: 'major-00', orientation: 'upright' },
    { cardId: 'major-01', orientation: 'reversed' },
  ],
  revealed: [false, false],
});
const password = 'journal emulator test password';
const verifyAccount = async (page, email) => {
  await verifyEmulatorEmail(email);
  const user = await page.evaluate(() => window.kit.journal.refreshAccount());
  assert.equal(user.emailVerified, true);
  return user.uid;
};
const account = async (page, email, create, trusted) => {
  const uid = await page.evaluate(
    async (args) => {
      const { journal } = window.kit;
      if (args.create) await journal.signUp(args.email, args.password, args.trusted);
      else await journal.signIn(args.email, args.password, args.trusted);
      const user = await window.observeUser();
      return user.uid;
    },
    { email, password, create, trusted },
  );
  if (create) assert.equal(await verifyAccount(page, email), uid);
  return uid;
};

const holdDeleteCommit = async (page, committed = false) => {
  const reached = Promise.withResolvers();
  const released = Promise.withResolvers();
  await page.route('**/documents:commit*', async (route) => {
    if (
      route
        .request()
        .postDataJSON()
        ?.writes?.some((write) => write.delete)
    ) {
      const response = committed ? await route.fetch() : undefined;
      if (response) assert.equal(response.status(), 200);
      reached.resolve();
      await released.promise;
      if (response) {
        if (!page.isClosed()) await route.fulfill({ response });
        return;
      }
    }
    if (!page.isClosed()) await route.continue();
  });
  return { reached: reached.promise, release: released.resolve };
};

test('imports wait for a confirmed deletion of the same ID before choosing a destination', async (t) => {
  const profile = await browser.newContext();
  t.after(() => profile.close());
  const page = await open(profile);
  const uid = await account(
    page,
    'import-after-delete-' + randomUUID() + '@example.test',
    true,
    true,
  );
  const original = entry(randomUUID());
  const replacement = { ...original, question: 'A new spread at the original ID' };
  const unrelated = entry(randomUUID());
  await page.evaluate(
    async ({ uid, original }) => {
      const { journal } = window.kit;
      await journal.createReading(uid, original);
      // Hold just this delete's document lookup, before it submits anything
      // to the shared Firestore client. Other IDs remain free to import.
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      const gate = Promise.withResolvers();
      window.releaseDelete = gate.resolve;
      crypto.subtle.digest = async (algorithm, data) => {
        if (new TextDecoder().decode(data) === original.id) {
          crypto.subtle.digest = digest;
          window.deleteReachedLookup = true;
          await gate.promise;
        }
        return digest(algorithm, data);
      };
      window.deletion = journal.removeReading(uid, original);
    },
    { uid, original },
  );
  await page.waitForFunction(() => window.deleteReachedLookup);
  const result = await page.evaluate(
    async ({ uid, replacement, unrelated }) => {
      const { journal } = window.kit;
      const [preview, restore, other] = await Promise.allSettled([
        journal.previewAccountImport(uid, [replacement]),
        journal.importAccountReadings(uid, [replacement]),
        journal.importAccountReadings(uid, [unrelated]),
      ]);
      return {
        preview: preview.reason?.message,
        restore: restore.reason?.message,
        other: other.value,
      };
    },
    { uid, replacement, unrelated },
  );
  assert.match(result.preview, /pending deletion/i);
  assert.match(result.restore, /pending deletion/i);
  assert.equal(result.other.added, 1);
  const restored = page.evaluate(
    ({ uid, replacement }) => window.kit.journal.importAccountReadings(uid, [replacement]),
    { uid, replacement },
  );
  await page.evaluate(() => window.releaseDelete());
  assert.equal((await restored).added, 1);
  await page.evaluate(() => window.deletion);
  const readings = await page.evaluate(
    async (uid) => JSON.parse(await window.kit.journal.exportAccountJournal(uid)).readings,
    uid,
  );
  assert.deepEqual(
    readings.find((reading) => reading.id === original.id),
    replacement,
  );
  assert.equal(readings.length, 2);
});

for (const writerHasWebLocks of [true, false])
  test(
    `durable deletion protects a sibling import while the writer ${writerHasWebLocks ? 'has' : 'lacks'} Web Locks`,
    { timeout: 45000 },
    async (t) => {
      const profile = await browser.newContext();
      t.after(() => profile.close());
      const writer = await open(profile);
      const uid = await account(
        writer,
        'sibling-import-' + randomUUID() + '@example.test',
        true,
        true,
      );
      const sibling = await open(profile);
      assert.equal((await sibling.evaluate(() => window.observeUser())).uid, uid);
      for (const page of writerHasWebLocks ? [sibling] : [writer, sibling])
        await page.evaluate(() => Object.defineProperty(navigator, 'locks', { value: undefined }));
      const original = entry(randomUUID());
      const unrelated = entry(randomUUID());
      const gate = await holdDeleteCommit(writer);
      t.after(gate.release);
      await writer.evaluate(
        async ({ uid, original }) => {
          await window.kit.journal.createReading(uid, original);
          window.deletion = window.kit.journal.removeReading(uid, original);
        },
        { uid, original },
      );
      await gate.reached;
      const { preview, restore, other } = await sibling.evaluate(
        async ({ uid, original, unrelated }) => {
          const { journal } = window.kit;
          const [preview, restore, other] = await Promise.allSettled([
            journal.previewAccountImport(uid, [{ ...original, question: 'Different spread' }]),
            journal.importAccountReadings(uid, [original]),
            journal.importAccountReadings(uid, [unrelated]),
          ]);
          return {
            preview: preview.reason?.message,
            restore: restore.reason?.message,
            other: other.value,
          };
        },
        { uid, original, unrelated },
      );
      assert.match(preview, /pending deletion/i);
      assert.match(restore, /pending deletion/i);
      assert.equal(other.added, 1);
      await assert.rejects(
        sibling.evaluate((uid) => window.kit.journal.exportAccountJournal(uid), uid),
        /deletion is still waiting/i,
      );
      // Read from a fresh tab as well, so a stale in-memory entry cannot hide
      // that a competing verifier prematurely removed the actual durable record.
      const inspector = await open(profile);
      assert.equal((await inspector.evaluate(() => window.observeUser())).uid, uid);
      await assert.rejects(
        inspector.evaluate((uid) => window.kit.journal.exportAccountJournal(uid), uid),
        /deletion is still waiting/i,
      );
      if (writerHasWebLocks) {
        await inspector.evaluate(() => {
          const open = indexedDB.open.bind(indexedDB);
          indexedDB.open = (name, ...args) => {
            if (name.startsWith('arcana.journal.deletions.'))
              throw new DOMException('Queue unavailable in this window', 'SecurityError');
            return open(name, ...args);
          };
        });
        await assert.rejects(
          inspector.evaluate(
            ({ uid, original }) =>
              window.kit.journal.importAccountReadings(uid, [original], undefined, true),
            { uid, original },
          ),
          /pending deletion/i,
        );
        const clean = await inspector.evaluate(
          ({ uid, unrelated }) => window.kit.journal.previewAccountImport(uid, [unrelated]),
          { uid, unrelated },
        );
        assert.equal(clean.skipped, 1);
        assert.equal(clean.uncheckedDeletions, undefined);
        await inspector.evaluate(() =>
          Object.defineProperty(window, 'Worker', { value: undefined }),
        );
        const unchecked = await inspector.evaluate(
          ({ uid, unrelated }) => window.kit.journal.previewAccountImport(uid, [unrelated]),
          { uid, unrelated },
        );
        assert.equal(unchecked.uncheckedDeletions, true);
        await assert.rejects(
          inspector.evaluate(
            ({ uid, unrelated }) => window.kit.journal.importAccountReadings(uid, [unrelated]),
            { uid, unrelated },
          ),
          /review the import again/i,
        );
        const confirmed = await inspector.evaluate(
          ({ uid, unrelated }) =>
            window.kit.journal.importAccountReadings(uid, [unrelated], undefined, true),
          { uid, unrelated },
        );
        assert.equal(confirmed.uncheckedDeletions, true);
        assert.equal(confirmed.skipped, 1);
      }
      gate.release();
      await writer.evaluate(() => window.deletion);
      const result = await sibling.evaluate(
        async ({ uid, original }) => {
          const { journal } = window.kit;
          const restore = await journal.importAccountReadings(uid, [original]);
          const rows = JSON.parse(await journal.exportAccountJournal(uid)).readings;
          return { restore, rows };
        },
        { uid, original },
      );
      assert.equal(result.restore.added, 1);
      assert.deepEqual(
        result.rows.find((row) => row.id === original.id),
        original,
      );
      assert.equal(result.rows.length, 2);
    },
  );

for (const storage of [
  'durable',
  'session-only',
  'worker lock',
  'IndexedDB reservation',
  'legacy IndexedDB',
]) {
  test(`imports in another tab see a pending delete using ${storage}`, async (t) => {
    const profile = await browser.newContext();
    t.after(() => profile.close());
    const email = 'delete-visibility-' + randomUUID() + '@example.test';
    // A separate session on the same origin uses the exact same portable ID.
    const otherOwner = await open(profile);
    const otherUid = await account(otherOwner, 'other-' + email, true, false);
    await loadHarness(otherOwner);
    assert.equal((await otherOwner.evaluate(() => window.observeUser())).uid, otherUid);
    const first = await open(profile);
    const trustedImporter = storage !== 'durable';
    const firstTrusted = trustedImporter && storage !== 'session-only';
    const uid = await account(first, email, true, firstTrusted);
    await loadHarness(first);
    assert.equal((await first.evaluate(() => window.observeUser())).uid, uid);
    const second = await open(profile);
    if (!firstTrusted) await account(second, email, false, true);
    assert.equal((await second.evaluate(() => window.observeUser())).uid, uid);
    const importer = storage === 'session-only' ? second : first;
    const writer = storage === 'session-only' ? first : second;
    assert.equal(
      await importer.evaluate((uid) => window.kit.journal.isOfflineJournalEnabled(uid), uid),
      trustedImporter,
    );
    const reading = entry(randomUUID());
    const unrelated = entry(randomUUID());
    if (storage === 'worker lock') {
      // The importing window hides the interface entirely, while its worker
      // can still see a lock registered by the other tab's worker.
      await importer.evaluate(() => {
        delete Navigator.prototype.locks;
        delete window.LockManager;
        Object.defineProperty(window, 'BroadcastChannel', { value: undefined });
      });
    }
    if (storage === 'legacy IndexedDB') {
      // Model engines that lack both Web Locks and database enumeration.
      for (const page of [writer, importer]) {
        await page.evaluate(() => {
          delete Navigator.prototype.locks;
          delete window.LockManager;
          delete IDBFactory.prototype.databases;
          Object.defineProperty(window, 'Worker', { value: undefined });
          Object.defineProperty(window, 'BroadcastChannel', { value: undefined });
        });
      }
    }
    if (firstTrusted) {
      await writer.evaluate(
        ({ uid, storage }) => {
          const add = IDBObjectStore.prototype.add;
          IDBObjectStore.prototype.add = function (value, ...args) {
            if (this.transaction.db.name === 'arcana.journal.deletions.v1:' + uid)
              throw new DOMException('Cannot store this reading', 'QuotaExceededError');
            return add.call(this, value, ...args);
          };
          if (storage !== 'legacy IndexedDB')
            Object.defineProperty(navigator, 'locks', { value: undefined });
          if (storage === 'IndexedDB reservation')
            Object.defineProperty(window, 'Worker', { value: undefined });
        },
        { uid, storage },
      );
    }
    const gate = await holdDeleteCommit(writer);
    t.after(gate.release);
    await writer.evaluate(
      async ({ uid, reading }) => {
        await window.kit.journal.createReading(uid, reading);
        window.deletion = window.kit.journal.removeReading(uid, reading);
      },
      { uid, reading },
    );
    await gate.reached;
    if (storage === 'legacy IndexedDB') {
      // Check the queued cleanup directly. The outer import deadline must
      // never turn a blocked, exact-ID database probe into an unchecked read.
      const probe = await importer.evaluate(
        async ({ uid, id }) => {
          const { deletionReservationName } = await import('/src/cloud/deletionReservation.ts');
          const { checkDeletion } = await import('/src/cloud/deletionStore.ts');
          const name = await deletionReservationName(uid, id);
          const start = performance.now();
          const busy = await checkDeletion({ kind: 'database', name });
          return { busy, elapsed: performance.now() - start };
        },
        { uid, id: reading.id },
      );
      assert.equal(probe.busy, true);
      assert.ok(probe.elapsed < 4000);
    }
    const isolated = await otherOwner.evaluate(
      ({ uid, reading }) => window.kit.journal.importAccountReadings(uid, [reading]),
      { uid: otherUid, reading },
    );
    assert.equal(isolated.added, 1);
    assert.equal(isolated.uncheckedDeletions, undefined);
    const state = await importer.evaluate(
      async ({ uid, reading, unrelated }) => {
        const { journal } = window.kit;
        const [preview, restore, other] = await Promise.allSettled([
          journal.previewAccountImport(uid, [reading]),
          journal.importAccountReadings(uid, [reading], undefined, true),
          journal.importAccountReadings(uid, [unrelated]),
        ]);
        return {
          preview: preview.reason?.message,
          restore: restore.reason?.message,
          other: other.value,
        };
      },
      { uid, reading, unrelated },
    );
    assert.match(state.preview, /pending deletion/i);
    assert.match(state.restore, /pending deletion/i);
    assert.equal(state.other.added, 1);
    assert.equal(state.other.uncheckedDeletions, undefined);
    gate.release();
    await writer.evaluate(() => window.deletion);
    const restored = await importer.evaluate(
      async ({ uid, reading }) => {
        const { journal } = window.kit;
        const counts = await journal.importAccountReadings(uid, [reading]);
        return { counts, readings: JSON.parse(await journal.exportAccountJournal(uid)).readings };
      },
      { uid, reading },
    );
    assert.equal(restored.counts.added, 1);
    assert.deepEqual(
      restored.readings.find((row) => row.id === reading.id),
      reading,
    );
    assert.equal(restored.readings.length, 2);
  });
}

test('a deletion that cannot register stays in the journal without sending a delete', async (t) => {
  const profile = await browser.newContext();
  t.after(() => profile.close());
  const page = await open(profile);
  const uid = await account(page, 'no-coordination-' + randomUUID() + '@example.test', true, false);
  const reading = entry(randomUUID());
  let sent = false;
  page.on('request', (req) => {
    if (req.url().includes('documents:commit') && req.postDataJSON()?.writes?.some((w) => w.delete))
      sent = true;
  });
  const state = await page.evaluate(
    async ({ uid, reading }) => {
      const { journal } = window.kit;
      await journal.createReading(uid, reading);
      Object.defineProperty(navigator, 'locks', { value: undefined });
      Object.defineProperty(window, 'Worker', { value: undefined });
      const open = indexedDB.open.bind(indexedDB);
      indexedDB.open = (name, ...args) => {
        if (name.startsWith('arcana.journal.volatile-delete:'))
          throw new DOMException('Database unavailable', 'SecurityError');
        return open(name, ...args);
      };
      const [deletion] = await Promise.allSettled([journal.removeReading(uid, reading)]);
      const [checked] = await Promise.allSettled([journal.exportAccountJournal(uid)]);
      return {
        message: deletion.reason?.message,
        exportError: checked.reason?.message,
        rows: JSON.parse(await journal.exportAccountJournal(uid, true)).readings,
      };
    },
    { uid, reading },
  );
  assert.match(state.message, /could not register the deletion/i);
  assert.match(state.exportError, /could not check deletions in other tabs/i);
  assert.deepEqual(state.rows, [reading]);
  assert.equal(sent, false);
});

test('a trusted sibling waits for a queued deletion before exporting the complete journal', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const writer = await open(context);
  const uid = await account(writer, 'delete-backup-' + randomUUID() + '@example.test', true, true);
  const sibling = await open(context);
  assert.equal((await sibling.evaluate(() => window.observeUser())).uid, uid);
  const reading = entry(randomUUID());
  await writer.evaluate(
    async ({ uid, reading }) => {
      const { journal, databaseFor, firestore } = window.kit;
      await journal.createReading(uid, reading);
      await firestore.disableNetwork(await databaseFor(uid));
      window.pendingReveal = journal.revealCards(uid, reading, [0]);
      journal.observePendingDeletions(uid, (requests) => {
        window.savedDelete = requests.some((request) => request.durable);
      });
      window.pendingDelete = journal.removeReading(uid, reading);
    },
    { uid, reading },
  );
  await writer.waitForFunction(() => window.savedDelete);
  await assert.rejects(
    sibling.evaluate((uid) => window.kit.journal.exportAccountJournal(uid), uid),
    /deletion is still waiting/i,
  );
  await writer.evaluate(async (uid) => {
    const { firestore, databaseFor } = window.kit;
    await firestore.enableNetwork(await databaseFor(uid));
    await Promise.all([window.pendingReveal, window.pendingDelete]);
  }, uid);
  await sibling.evaluate((uid) => {
    window.kit.journal.observeReadings(
      uid,
      10,
      (_rows, status) => {
        window.siblingReconnected = !status.fromCache && !status.pending;
      },
      (error) => {
        throw error;
      },
    );
  }, uid);
  await sibling.waitForFunction(() => window.siblingReconnected);
  assert.deepEqual(
    await sibling.evaluate(
      async (uid) => JSON.parse(await window.kit.journal.exportAccountJournal(uid)).readings,
      uid,
    ),
    [],
  );
});

test(
  'closing the tab during a deletion releases its claim for a waiting sibling to verify',
  { timeout: 30000 },
  async (t) => {
    const profile = await browser.newContext();
    t.after(() => profile.close());
    const writer = await open(profile);
    const uid = await account(writer, 'closed-claim-' + randomUUID() + '@example.test', true, true);
    const sibling = await open(profile);
    assert.equal((await sibling.evaluate(() => window.observeUser())).uid, uid);
    const reading = entry(randomUUID());
    // Commit at the emulator and keep the acknowledgment in flight.
    const gate = await holdDeleteCommit(writer, true);
    t.after(gate.release);
    await writer.evaluate(
      async ({ uid, reading }) => {
        const { journal } = window.kit;
        await journal.createReading(uid, reading);
        window.deletion = journal.removeReading(uid, reading);
      },
      { uid, reading },
    );
    await gate.reached;
    await sibling.evaluate((uid) => {
      window.kit.journal.observePendingDeletions(uid, (requests, error) => {
        if (requests.length) window.waitingForWriter = true;
        else if (window.waitingForWriter) window.verifiedDeletion = true;
        if (error) window.resultAfterClose = error;
      });
    }, uid);
    await sibling.waitForFunction(() => window.waitingForWriter, undefined, { timeout: 6000 });
    await writer.close();
    gate.release();
    await sibling.waitForFunction(() => window.verifiedDeletion, undefined, { timeout: 10000 });
    assert.equal(await sibling.evaluate(() => window.resultAfterClose), undefined);
    const rows = await sibling.evaluate(
      async (uid) => JSON.parse(await window.kit.journal.exportAccountJournal(uid)).readings,
      uid,
    );
    assert.deepEqual(rows, []);
    await sibling.waitForFunction(
      async () =>
        (await indexedDB.databases()).every(
          ({ name }) => !name?.startsWith('arcana.journal.deletion-lock:'),
        ),
      undefined,
      { timeout: 6000 },
    );
  },
);

for (const action of ['delete', 'clear'])
  test(`a lost ${action} acknowledgment preserves an identical reading restored before the SDK retries`, async (t) => {
    const profile = await browser.newContext();
    const peerProfile = await browser.newContext();
    t.after(() => Promise.all([profile.close(), peerProfile.close()]));
    const page = await open(profile);
    const peer = await open(peerProfile);
    const email = 'ambiguous-delete-' + randomUUID() + '@example.test';
    const uid = await account(page, email, true, true);
    await account(peer, email, false, false);
    const original = entry(randomUUID());
    await page.evaluate(({ uid, original }) => window.kit.journal.createReading(uid, original), {
      uid,
      original,
    });

    let deleteCommits = 0;
    await page.route('**/documents:commit*', async (route) => {
      if (
        !route
          .request()
          .postDataJSON()
          ?.writes?.some((write) => write.delete)
      ) {
        await route.continue();
        return;
      }
      if (++deleteCommits > 1) {
        await route.continue();
        return;
      }
      const committed = await route.fetch();
      assert.equal(committed.status(), 200);
      await peer.evaluate(
        ({ uid, original }) => window.kit.journal.importAccountReadings(uid, [original]),
        { uid, original },
      );
      await route.fulfill({
        response: committed,
        status: 503,
        json: {
          error: {
            code: 503,
            status: 'UNAVAILABLE',
            message: 'Commit acknowledgment unavailable.',
          },
        },
      });
    });
    await assert.rejects(
      page.evaluate(
        ({ uid, original, action }) => {
          if (action === 'clear')
            return window.kit.journal.clearReadings(uid, () => {
              window.pageSubmitted = true;
            });
          window.kit.journal.observePendingDeletions(uid, () => {});
          return window.kit.journal.removeReading(uid, original);
        },
        { uid, original, action },
      ),
      action === 'clear' ? /acknowledgment unavailable/i : /confirm again/i,
    );
    if (action === 'clear') assert.equal(await page.evaluate(() => window.pageSubmitted), true);
    assert.equal(deleteCommits, 1);
    assert.deepEqual(
      await peer.evaluate(
        async (uid) => JSON.parse(await window.kit.journal.exportAccountJournal(uid)).readings,
        uid,
      ),
      [original],
    );
  });

test('a deletion with interrupted cleanup cannot remove an identical reading restored after the commit', async (t) => {
  const profile = await browser.newContext();
  const peerProfile = await browser.newContext();
  t.after(() => Promise.all([profile.close(), peerProfile.close()]));
  const page = await open(profile);
  const peer = await open(peerProfile);
  const email = 'deletion-receipt-' + randomUUID() + '@example.test';
  const uid = await account(page, email, true, true);
  await account(peer, email, false, false);
  const original = entry(randomUUID());
  await page.evaluate(
    async ({ uid, original }) => {
      const { journal } = window.kit;
      await journal.createReading(uid, original);
      Object.defineProperty(navigator, 'locks', { value: undefined });
      const remove = IDBObjectStore.prototype.delete;
      IDBObjectStore.prototype.delete = function (key) {
        if (this.transaction.db.name === 'arcana.journal.deletions.v1:' + uid) {
          throw new DOMException('Cleanup unavailable', 'ReadOnlyError');
        }
        return remove.call(this, key);
      };
      journal.observePendingDeletions(uid, (_requests, error) => {
        if (error) window.deletionStatus = error;
      });
      void journal.removeReading(uid, original);
    },
    { uid, original },
  );
  await page.waitForFunction(() => window.deletionStatus?.includes('server checked'));
  assert.deepEqual(
    await peer.evaluate(
      async (uid) => JSON.parse(await window.kit.journal.exportAccountJournal(uid)).readings,
      uid,
    ),
    [],
  );
  await page.close();
  await peer.evaluate(
    async ({ uid, original }) => window.kit.journal.importAccountReadings(uid, [original]),
    { uid, original },
  );
  const reopened = await open(profile);
  assert.equal((await reopened.evaluate(() => window.observeUser())).uid, uid);
  await reopened.evaluate((uid) => {
    window.kit.journal.observePendingDeletions(uid, (_requests, error) => {
      if (error) window.deletionStatus = error;
    });
  }, uid);
  await reopened.waitForFunction(() => window.deletionStatus?.includes('confirm again'));
  assert.deepEqual(
    await peer.evaluate(
      async (uid) => JSON.parse(await window.kit.journal.exportAccountJournal(uid)).readings,
      uid,
    ),
    [original],
  );
});

test('recovery reuses the assigned collision ID after the earlier occupant is deleted', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await open(context);
  const uid = await account(page, 'collision-gap-' + randomUUID() + '@example.test', true, true);
  const original = entry('original-' + randomUUID());
  const result = await page.evaluate(
    async ({ uid, original }) => {
      const { journal } = window.kit;
      const { collisionReadingId } = await import('/src/domain/journalBackup.ts');
      const { loadRecoveryCopies, saveRecoveryCopy } = await import(
        '/src/domain/readingRecovery.ts'
      );
      const primary = { ...original, question: 'The primary occupant' };
      const blocker = { ...primary, id: await collisionReadingId(original) };
      await journal.createReading(uid, primary);
      await journal.createReading(uid, blocker);
      saveRecoveryCopy(uid, original);
      await journal.importAccountReadings(uid, [original]);
      const [receipt] = loadRecoveryCopies(uid).copies;
      await journal.removeReading(uid, blocker);
      const withProgress = { ...original, revealed: original.revealed.map(() => true) };
      const retry = await journal.importAccountReadings(uid, [withProgress]);
      const rows = JSON.parse(await journal.exportAccountJournal(uid)).readings;
      const assigned = { ...withProgress, id: receipt.importedAs };
      const independent = { ...original, id: await collisionReadingId(original, 100) };
      await journal.createReading(uid, independent);
      await journal.removeReading(uid, assigned);
      const preview = await journal.previewAccountImport(uid, [assigned]);
      const restored = await journal.importAccountReadings(uid, [assigned]);
      const afterRestore = JSON.parse(await journal.exportAccountJournal(uid)).readings;
      return {
        retry,
        savedId: receipt.importedAs,
        rows,
        preview,
        restored,
        afterRestore,
        independent,
        assigned,
      };
    },
    { uid, original },
  );
  assert.equal(result.retry.added, 0);
  assert.equal(result.rows.length, 2);
  const recovered = result.rows.find((row) => row.question === original.question);
  assert.equal(recovered.id, result.savedId);
  assert.ok(recovered.revealed.every(Boolean));
  assert.equal(result.preview.added, 1);
  assert.equal(result.restored.added, 1);
  assert.deepEqual(
    result.afterRestore.find(({ id }) => id === result.independent.id),
    result.independent,
  );
  assert.deepEqual(
    result.afterRestore.find(({ id }) => id === result.savedId),
    result.assigned,
  );
});

for (const denied of ['reading the retained copy', 'writing the assigned ID']) {
  test('an unchecked recovery cannot commit after losing access to ' + denied, async (t) => {
    const context = await browser.newContext();
    t.after(() => context.close());
    const page = await open(context);
    const uid = await account(
      page,
      'retained-target-' + randomUUID() + '@example.test',
      true,
      true,
    );
    const original = entry(randomUUID());
    const result = await page.evaluate(
      async ({ uid, original, denied }) => {
        const { journal } = window.kit;
        const { loadRecoveryCopies, saveRecoveryCopy, retainRecoveryCopies, removeRecoveryCopies } =
          await import('/src/domain/readingRecovery.ts');
        const collision = denied === 'writing the assigned ID';
        if (collision)
          await journal.createReading(uid, { ...original, question: 'Prior occupant' });
        const source = saveRecoveryCopy(uid, original);
        const open = indexedDB.open.bind(indexedDB);
        indexedDB.open = (name, ...args) => {
          if (name.startsWith('arcana.journal.deletions.')) throw new Error('Queue unavailable');
          return open(name, ...args);
        };
        const worker = window.Worker;
        window.Worker = undefined;
        const preview = await journal.previewAccountImport(uid, [original]);
        const retained = retainRecoveryCopies(uid, loadRecoveryCopies(uid).copies);
        // A previous acknowledgement removes the original after confirmation.
        removeRecoveryCopies([source]);
        const get = Storage.prototype.getItem;
        const set = Storage.prototype.setItem;
        Storage.prototype.getItem = function (key) {
          if (!collision && key === retained[0].key) throw new Error('Read unavailable');
          return get.call(this, key);
        };
        Storage.prototype.setItem = function (key, value) {
          if (collision && key.endsWith(retained[0].key)) throw new Error('Storage full');
          return set.call(this, key, value);
        };
        let error;
        let ordinary;
        try {
          const attempt = journal.importAccountReadings(uid, [original], undefined, true, retained);
          error = await attempt.then(
            () => null,
            (cause) => cause.message,
          );
          ordinary = await journal.importAccountReadings(
            uid,
            [{ ...original, id: 'independent-file-reading' }],
            undefined,
            true,
          );
        } finally {
          Storage.prototype.getItem = get;
          Storage.prototype.setItem = set;
        }
        const beforeRetry = JSON.parse(await journal.exportAccountJournal(uid, true)).readings;
        const imported = await journal.importAccountReadings(
          uid,
          [original],
          undefined,
          true,
          retained,
        );
        const [copy] = loadRecoveryCopies(uid).copies;
        indexedDB.open = open;
        window.Worker = worker;
        const target = { ...copy.reading, id: copy.importedAs ?? copy.reading.id };
        const checked = await journal.importAccountReadings(uid, [target]);
        const rows = JSON.parse(await journal.exportAccountJournal(uid)).readings;
        return { preview, error, ordinary, beforeRetry, imported, target, checked, rows };
      },
      { uid, original, denied },
    );
    assert.equal(result.preview.uncheckedDeletions, true);
    assert.match(result.error, /retained recovery copy|save the assigned ID/i);
    assert.equal(result.ordinary.added, 1);
    assert.ok(
      !result.beforeRetry.some(
        (row) => row.question === original.question && row.id !== 'independent-file-reading',
      ),
    );
    assert.equal(result.imported.added, 1);
    assert.equal(result.imported.uncheckedDeletions, true);
    assert.equal(result.checked.skipped, 1);
    assert.equal(result.checked.uncheckedDeletions, undefined);
    assert.deepEqual(
      result.rows.find((row) => row.id === result.target.id),
      result.target,
    );
    assert.equal(result.rows.length, denied === 'writing the assigned ID' ? 3 : 2);
  });
}

test('a one-reading backup updates its explicit ID when a local receipt names an identical spread', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await open(context);
  const uid = await account(page, 'primary-receipt-' + randomUUID() + '@example.test', true, true);
  const original = entry(randomUUID());
  const result = await page.evaluate(
    async ({ uid, original }) => {
      const { journal } = window.kit;
      const { loadRecoveryCopies, saveRecoveryCopy } = await import(
        '/src/domain/readingRecovery.ts'
      );
      const occupant = { ...original, question: 'An older draw at this ID' };
      await journal.createReading(uid, occupant);
      saveRecoveryCopy(uid, original);
      await journal.importAccountReadings(uid, [original]);
      const [{ importedAs }] = loadRecoveryCopies(uid).copies;
      await journal.removeReading(uid, occupant);
      await journal.createReading(uid, { ...original, revealed: [true, false] });

      const alreadyShown = await journal.previewAccountImport(uid, [
        { ...original, revealed: [true, false] },
      ]);
      const backup = [{ ...original, revealed: [false, true] }];
      const preview = await journal.previewAccountImport(uid, backup);
      const imported = await journal.importAccountReadings(uid, backup);
      const rows = JSON.parse(await journal.exportAccountJournal(uid)).readings;
      return { importedAs, alreadyShown, preview, imported, rows };
    },
    { uid, original },
  );
  assert.equal(result.alreadyShown.skipped, 1);
  assert.equal(result.preview.updated, 1);
  assert.equal(result.imported.updated, 1);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(
    result.rows.find(({ id }) => id === original.id),
    { ...original, revealed: [true, true] },
  );
  assert.deepEqual(
    result.rows.find(({ id }) => id === result.importedAs),
    { ...original, id: result.importedAs },
  );
});

test('account backup restores both explicit IDs of an otherwise ambiguous pair', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await open(context);
  const uid = await account(page, 'portable-pair-' + randomUUID() + '@example.test', true, true);
  const original = entry('primary-' + randomUUID());
  const results = await page.evaluate(
    async ({ uid, original }) => {
      const { journal } = window.kit;
      const { collisionReadingId } = await import('/src/domain/journalBackup.ts');
      const alternate = {
        ...original,
        id: await collisionReadingId(original, 73),
        revealed: [true, false],
      };
      const counts = [];
      for (const rows of [
        [alternate, original],
        [original, alternate],
      ]) {
        await journal.clearReadings(uid);
        const preview = await journal.previewAccountImport(uid, rows);
        const imported = await journal.importAccountReadings(uid, rows);
        const saved = JSON.parse(await journal.exportAccountJournal(uid)).readings;
        counts.push([
          preview.added,
          imported.added,
          saved.length,
          saved.find((row) => row.id === alternate.id)?.revealed,
        ]);
      }
      return counts;
    },
    { uid, original },
  );
  assert.deepEqual(results, [
    [2, 2, 2, [true, false]],
    [2, 2, 2, [true, false]],
  ]);
});

test(
  'clear registration blocks checked imports and both export modes before its first server commit reaches Firebase',
  { timeout: 30000 },
  async (t) => {
    const profile = await browser.newContext();
    t.after(() => profile.close());
    const importer = await open(profile);
    const email = 'clear-registration-' + randomUUID() + '@example.test';
    const uid = await account(importer, email, true, false);
    await loadHarness(importer);
    const writer = await open(profile);
    await account(writer, email, false, true);
    const reading = entry(randomUUID());
    await writer.evaluate(
      async ({ uid, reading }) => {
        await window.kit.journal.createReading(uid, reading);
        // The registering tab uses the IndexedDB fallback. The importing tab
        // retains normal window permissions and must see the same reservation.
        Object.defineProperty(navigator, 'locks', { value: undefined });
        Object.defineProperty(window, 'Worker', { value: undefined });
      },
      { uid, reading },
    );
    const reached = Promise.withResolvers();
    const released = Promise.withResolvers();
    t.after(released.resolve);
    await writer.route('**/documents:commit*', async (route) => {
      if (
        route
          .request()
          .postDataJSON()
          ?.writes?.some((w) => w.update?.name.endsWith('/journalOperations/clear'))
      ) {
        reached.resolve();
        await released.promise;
      }
      await route.continue();
    });
    await writer.evaluate((uid) => {
      window.clearing = window.kit.journal.clearReadings(uid);
    }, uid);
    await reached.promise;
    for (const method of ['previewAccountImport', 'importAccountReadings'])
      await assert.rejects(
        importer.evaluate(
          ({ uid, reading, method }) => window.kit.journal[method](uid, [reading]),
          { uid, reading, method },
        ),
        /clear is starting/i,
      );
    for (const allowUnchecked of [false, true])
      await assert.rejects(
        importer.evaluate(
          ({ uid, allowUnchecked }) => window.kit.journal.exportAccountJournal(uid, allowUnchecked),
          { uid, allowUnchecked },
        ),
        /deletion is still waiting|clear is starting/i,
      );
    released.resolve();
    await writer.evaluate(() => window.clearing);
    const restored = await importer.evaluate(
      async ({ uid, reading }) => {
        const { journal, firestore, databaseFor } = window.kit;
        const control = firestore.doc(
          await databaseFor(uid),
          'users',
          uid,
          'journalOperations',
          'clear',
        );
        return {
          active: (await firestore.getDocFromServer(control)).get('active'),
          result: await journal.importAccountReadings(uid, [reading]),
          rows: JSON.parse(await journal.exportAccountJournal(uid)).readings,
        };
      },
      { uid, reading },
    );
    assert.equal(restored.active, false);
    assert.equal(restored.result.added, 1);
    assert.deepEqual(restored.rows, [reading]);
  },
);

test('clear-operation rules restrict the document, contents and owner', async (t) => {
  const profile = await browser.newContext();
  t.after(() => profile.close());
  const page = await open(profile);
  const uid = await account(page, 'clear-rules-' + randomUUID() + '@example.test', true, false);
  const result = await page.evaluate(async (uid) => {
    const { databaseFor, firestore, journal } = window.kit;
    const db = await databaseFor(uid);
    const control = firestore.doc(db, 'users', uid, 'journalOperations', 'clear');
    const unrelated = firestore.doc(db, 'users', uid, 'journalOperations', 'other');
    const stranger = firestore.doc(db, 'users', uid + '-other', 'journalOperations', 'clear');
    const valid = { token: crypto.randomUUID(), active: true };
    await firestore.setDoc(control, valid);
    const errorCode = async (operation) => {
      try {
        await operation;
        return 'allowed';
      } catch (error) {
        return error.code;
      }
    };
    const denied = await Promise.all([
      errorCode(firestore.getDocFromServer(stranger)),
      errorCode(firestore.setDoc(stranger, valid)),
      errorCode(firestore.deleteDoc(stranger)),
      errorCode(firestore.getDocFromServer(unrelated)),
      errorCode(firestore.setDoc(unrelated, valid)),
      errorCode(firestore.getDocsFromServer(control.parent)),
      errorCode(firestore.setDoc(control, {})),
      errorCode(firestore.setDoc(control, { ...valid, token: 'malformed' })),
      errorCode(firestore.setDoc(control, { ...valid, active: 1 })),
      errorCode(firestore.deleteDoc(control)),
      errorCode(firestore.setDoc(control, { ...valid, extra: true })),
    ]);
    // A preview must not supersede a clear or write to this document.
    const reading = {
      id: 'test',
      createdAt: '2026-01-02T10:00:00Z',
      question: '',
      cards: [{ cardId: 'major-00', orientation: 'upright' }],
      revealed: [false],
    };
    await journal.previewAccountImport(uid, [reading]);
    const afterPreview = (await firestore.getDocFromServer(control)).data();
    await journal.importAccountReadings(uid, [reading]);
    const afterImport = (await firestore.getDocFromServer(control)).data();
    await journal.importAccountReadings(uid, [reading]);
    const afterSkip = (await firestore.getDocFromServer(control)).data();
    return { denied, valid, afterPreview, afterImport, afterSkip };
  }, uid);
  assert.deepEqual(result.denied, Array(11).fill('permission-denied'));
  assert.deepEqual(result.afterPreview, result.valid);
  assert.equal(result.afterImport.active, false);
  assert.notEqual(result.afterImport.token, result.valid.token);
  assert.deepEqual(result.afterSkip, result.afterImport);
});

test('the owner must verify their email before Firestore permits access to readings', async () => {
  const context = await browser.newContext();
  try {
    const page = await open(context);
    const email = 'verification-' + randomUUID() + '@example.test';
    await page.evaluate(
      async ({ email, password }) => {
        const { journal, firestore, getAuth } = window.kit;
        await journal.signUp(email, password);
        const result = await getAuth().currentUser.getIdTokenResult();
        if (result.claims.email_verified !== false)
          throw new Error('Expected a pending email verification');
        // Keep a rules-test client on the actual pre-verification token while the
        // application refreshes its separate Firestore client's credentials.
        firestore.connectFirestoreEmulator(firestore.getFirestore(), '127.0.0.1', 8080, {
          mockUserToken: result.token,
        });
      },
      { email, password },
    );
    const uid = await verifyAccount(page, email);
    const reading = entry(randomUUID());
    const denied = await page.evaluate(
      async ({ uid, reading }) => {
        const { journal, databaseFor, firestore } = window.kit;
        await journal.createReading(uid, reading);
        const rows = await firestore.getDocsFromServer(
          firestore.collection(await databaseFor(uid), 'users', uid, 'readings'),
        );
        const [saved] = rows.docs;
        const pendingClient = firestore.getFirestore();
        const ref = firestore.doc(pendingClient, saved.ref.path);
        const errorCode = async (operation) => {
          try {
            await operation;
            return 'allowed';
          } catch (error) {
            return error.code;
          }
        };
        const read = await errorCode(firestore.getDocFromServer(ref));
        const list = await errorCode(firestore.getDocsFromServer(ref.parent));
        const update = await errorCode(firestore.updateDoc(ref, { revealedSlots: [0] }));
        const remove = await errorCode(firestore.deleteDoc(ref));
        await journal.revealCards(uid, reading, [0]);
        await journal.removeReading(uid, reading);
        const create = await errorCode(firestore.setDoc(ref, saved.data()));
        const control = firestore.doc(pendingClient, 'users', uid, 'journalOperations', 'clear');
        const clearRead = await errorCode(firestore.getDocFromServer(control));
        const clearWrite = await errorCode(
          firestore.setDoc(control, { token: crypto.randomUUID(), active: true }),
        );
        const clearDelete = await errorCode(firestore.deleteDoc(control));
        return { read, list, update, remove, create, clearRead, clearWrite, clearDelete };
      },
      { uid, reading },
    );
    assert.deepEqual(denied, {
      read: 'permission-denied',
      list: 'permission-denied',
      update: 'permission-denied',
      remove: 'permission-denied',
      create: 'permission-denied',
      clearRead: 'permission-denied',
      clearWrite: 'permission-denied',
      clearDelete: 'permission-denied',
    });
  } finally {
    await context.close();
  }
});

test('two browsers merge reveals, import legacy backups, isolate users, and resume offline work', async () => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  const device = await open(first);
  const laptop = await open(second);
  const email = 'reader-' + randomUUID() + '@example.test';
  const uid = await account(device, email, true, true);
  assert.equal(await account(laptop, email, false, false), uid);
  const reading = entry('legacy/id-' + randomUUID());
  const imported = await device.evaluate(
    async ({ uid, reading }) => {
      const { journal } = window.kit;
      const preview = await journal.previewAccountImport(uid, [reading]);
      const progress = [];
      const added = await journal.importAccountReadings(uid, [reading], (completed) =>
        progress.push(completed),
      );
      const retry = await journal.importAccountReadings(uid, [reading]);
      const changed = { ...reading, question: 'Another device drew this spread' };
      const conflict = await journal.importAccountReadings(uid, [changed]);
      const secondRetry = await journal.importAccountReadings(uid, [changed]);
      return { preview, added, retry, conflict, secondRetry, progress };
    },
    { uid, reading },
  );
  assert.equal(imported.preview.added, 1);
  assert.equal(imported.added.added, 1);
  assert.equal(imported.retry.skipped, 1);
  assert.equal(imported.conflict.added, 1);
  assert.equal(imported.secondRetry.skipped, 1);
  assert.deepEqual(imported.progress, [1]);

  const reopened = await open(first);
  assert.equal(await reopened.evaluate(async () => (await window.observeUser())?.uid), uid);
  await reopened.close();
  await device.evaluate(
    async ({ uid, reading }) => {
      const { journal, databaseFor, firestore } = window.kit;
      window.watch = journal.observeReadings(
        uid,
        1,
        (entries, status) => {
          window.firstPage = { entries, status };
        },
        (error) => {
          throw error;
        },
      );
      // Populate the trusted cache before simulating a disconnection.
      await journal.exportAccountJournal(uid);
      await firestore.disableNetwork(await databaseFor(uid));
      window.offlineReveal = journal.revealCards(uid, reading, [0]);
    },
    { uid, reading },
  );
  await device.waitForFunction(() => window.firstPage?.status.fromCache);
  await laptop.evaluate(
    async ({ uid, reading }) => window.kit.journal.revealCards(uid, reading, [1]),
    {
      uid,
      // Equivalent timestamps in a restored backup describe the same spread.
      reading: { ...reading, createdAt: '2026-01-02T10:00:00+00:00' },
    },
  );
  const pendingSignOut = await device.evaluate(async () => {
    try {
      await window.kit.journal.signOutAccount();
      return '';
    } catch (error) {
      return error.message;
    }
  });
  assert.match(pendingSignOut, /sync|changes/i);
  await device.evaluate(async (uid) => {
    const { databaseFor, firestore } = window.kit;
    await firestore.enableNetwork(await databaseFor(uid));
    await window.offlineReveal;
  }, uid);
  await device.waitForFunction(() => window.firstPage?.status.hasMore === true);
  const backup = await laptop.evaluate(
    async (uid) => JSON.parse(await window.kit.journal.exportAccountJournal(uid)),
    uid,
  );
  assert.equal(backup.readings.length, 2);
  assert.deepEqual(backup.readings.find((row) => row.id === reading.id).revealed, [true, true]);

  // An offline draw and immediate reveal must be queued in interaction order.
  const next = entry(randomUUID());
  await device.evaluate(
    async ({ uid, next }) => {
      const { journal, databaseFor, firestore } = window.kit;
      const database = await databaseFor(uid);
      await firestore.disableNetwork(database);
      const pending = Promise.all([
        journal.createReading(uid, next),
        journal.revealCards(uid, next, [0]),
      ]);
      await firestore.enableNetwork(database);
      await pending;
    },
    { uid, next },
  );
  await laptop.evaluate(async ({ uid, next }) => window.kit.journal.removeReading(uid, next), {
    uid,
    next,
  });
  await assert.rejects(
    device.evaluate(async ({ uid, next }) => window.kit.journal.revealCards(uid, next, [1]), {
      uid,
      next,
    }),
  );

  const restrictions = await laptop.evaluate(
    async ({ uid, reading }) => {
      const { databaseFor, firestore } = window.kit;
      const db = await databaseFor(uid);
      const rows = await firestore.getDocsFromServer(
        firestore.collection(db, 'users', uid, 'readings'),
      );
      const ref = rows.docs.find((doc) => doc.get('id') === reading.id).ref;
      const denied = async (operation) => {
        try {
          await operation;
          return false;
        } catch (error) {
          return error.code === 'permission-denied';
        }
      };
      return Promise.all([
        denied(firestore.updateDoc(ref, { question: 'Replaced' })),
        denied(firestore.updateDoc(ref, { revealedSlots: [] })),
        denied(firestore.updateDoc(ref, { revealedSlots: [0, 1, 2] })),
        denied(firestore.setDoc(firestore.doc(ref.parent, 'wrong-key'), rows.docs[0].data())),
      ]);
    },
    { uid, reading },
  );
  assert.deepEqual(restrictions, [true, true, true, true]);
  await laptop.evaluate(() => window.kit.journal.signOutAccount());
  const newUid = await account(laptop, 'other-' + randomUUID() + '@example.test', true, false);
  const other = await laptop.evaluate(
    async ({ uid, newUid }) => {
      const { databaseFor, firestore, journal } = window.kit;
      const db = await databaseFor(newUid);
      const unauthorized = firestore.collection(db, 'users', uid, 'readings');
      let denied = false;
      try {
        await firestore.getDocsFromServer(unauthorized);
      } catch (error) {
        denied = error.code === 'permission-denied';
      }
      let deleteDenied = false;
      try {
        await firestore.deleteDoc(firestore.doc(unauthorized, 'foreign'));
      } catch (error) {
        deleteDenied = error.code === 'permission-denied';
      }
      return {
        denied,
        deleteDenied,
        own: JSON.parse(await journal.exportAccountJournal(newUid)).readings,
      };
    },
    { uid, newUid },
  );
  assert.equal(other.denied, true);
  assert.equal(other.deleteDenied, true);
  assert.deepEqual(other.own, []);
  await device.evaluate(async (uid) => {
    window.watch();
    await window.kit.journal.clearReadings(uid);
  }, uid);
  assert.equal(
    await device.evaluate(
      async (uid) => JSON.parse(await window.kit.journal.exportAccountJournal(uid)).readings.length,
      uid,
    ),
    0,
  );
});

test('an offline reveal and deletion are refused if another device replaces the spread at the same legacy ID', async (t) => {
  const writer = await browser.newContext();
  const peer = await browser.newContext();
  t.after(() => Promise.all([writer.close(), peer.close()]));
  const device = await open(writer);
  const laptop = await open(peer);
  const email = 'stale-reveal-' + randomUUID() + '@example.test';
  const uid = await account(device, email, true, true);
  assert.equal(await account(laptop, email, false, false), uid);
  const original = entry('legacy/id-' + randomUUID());
  const replacement = {
    ...original,
    question: 'A different spread',
    cards: [...original.cards].reverse(),
  };
  await device.evaluate(
    async ({ uid, original }) => {
      const { journal, databaseFor, firestore } = window.kit;
      await journal.createReading(uid, original);
      await firestore.disableNetwork(await databaseFor(uid));
      window.stopReading = journal.observeReading(
        uid,
        original.id,
        (reading) => {
          window.localReveal = reading?.revealed[1];
        },
        (error) => {
          throw error;
        },
      );
      window.revealResult = journal.revealCards(uid, original, [1]).then(
        () => 'accepted',
        (error) => error.code,
      );
      window.deleteResult = journal.removeReading(uid, original).then(
        () => 'accepted',
        (error) => error.message,
      );
    },
    { uid, original },
  );
  await device.waitForFunction(() => window.localReveal === true);
  await laptop.evaluate(
    async ({ uid, original, replacement }) => {
      const { journal } = window.kit;
      await journal.removeReading(uid, original);
      await journal.importAccountReadings(uid, [replacement]);
    },
    { uid, original, replacement },
  );
  const result = await device.evaluate(async (uid) => {
    const { databaseFor, firestore } = window.kit;
    await firestore.enableNetwork(await databaseFor(uid));
    const result = await window.revealResult;
    window.stopReading();
    return result;
  }, uid);
  assert.equal(result, 'permission-denied');
  assert.match(await device.evaluate(() => window.deleteResult), /different reading/);
  const exported = await laptop.evaluate(
    async (uid) => JSON.parse(await window.kit.journal.exportAccountJournal(uid)).readings,
    uid,
  );
  assert.deepEqual(exported, [replacement]);
  const recovered = await device.evaluate(
    async ({ uid, original }) => {
      const { journal } = window.kit;
      await journal.importAccountReadings(uid, [{ ...original, revealed: [false, true] }]);
      return JSON.parse(await journal.exportAccountJournal(uid)).readings;
    },
    { uid, original },
  );
  assert.equal(recovered.length, 2);
  assert.deepEqual(
    recovered.find((row) => row.id === original.id),
    replacement,
  );
  const restored = recovered.find((row) => row.id !== original.id);
  assert.match(restored.id, /^import-/);
  assert.deepEqual(restored, { ...original, id: restored.id, revealed: [false, true] });
});

test('trusted account reopens its cached readings with both Firebase services offline', async () => {
  const context = await browser.newContext();
  const initial = await open(context);
  const uid = await account(initial, 'trusted-' + randomUUID() + '@example.test', true, true);
  const reading = entry(randomUUID());
  await initial.evaluate(
    async ({ uid, reading }) => {
      const { journal } = window.kit;
      await journal.createReading(uid, reading);
      await journal.exportAccountJournal(uid);
    },
    { uid, reading },
  );
  await initial.close();
  await context.route(/^http:\/\/127\.0\.0\.1:(8080|9099)\//, (route) =>
    route.abort('internetdisconnected'),
  );
  const restored = await open(context);
  assert.equal(await restored.evaluate(async () => (await window.observeUser())?.uid), uid);
  await restored.evaluate(async (uid) => {
    const { journal } = window.kit;
    journal.observeReadings(
      uid,
      50,
      (readings, state) => {
        window.saved = { readings, state };
      },
      (error) => {
        throw error;
      },
    );
  }, uid);
  await restored.waitForFunction(
    () => window.saved?.state.fromCache && window.saved.readings.length > 0,
  );
  assert.equal(await restored.evaluate(() => window.saved.readings[0].id), reading.id);
  await context.close();
});

test('an earlier unlock cannot override a new lock in another tab', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const first = await open(context);
  const uid = await account(first, 'relock-' + randomUUID() + '@example.test', true, true);
  const second = await open(context);
  assert.equal(await second.evaluate(async () => (await window.observeUser())?.uid), uid);
  await first.evaluate((uid) => window.kit.journal.lockJournal(uid), uid);

  // Keep the first password request in flight while the owner unlocks and relocks in another tab.
  await first.route(
    '**/accounts:signInWithPassword?*',
    async (route) => {
      await second.evaluate(
        async ({ uid, password }) => {
          await window.kit.journal.unlockJournal(uid, password);
          await window.kit.journal.lockJournal(uid);
        },
        { uid, password },
      );
      await route.continue();
    },
    { times: 1 },
  );
  const unlock = () =>
    first.evaluate(({ uid, password }) => window.kit.journal.unlockJournal(uid, password), {
      uid,
      password,
    });
  await assert.rejects(unlock(), /locked again|account has changed/i);
  assert.equal(await first.evaluate((uid) => window.kit.journal.isJournalLocked(uid), uid), true);
  await unlock();
  assert.equal(await second.evaluate((uid) => window.kit.journal.isJournalLocked(uid), uid), false);
});

const denyJournalStorageReads = () => {
  const getItem = Storage.prototype.getItem;
  Storage.prototype.getItem = function (key) {
    if (this === window.localStorage && key.startsWith('arcana.')) {
      throw new DOMException('Storage denied', 'SecurityError');
    }
    return getItem.call(this, key);
  };
  window.restoreStorage = () => {
    Storage.prototype.getItem = getItem;
  };
};

test('a storage-restricted tab reauthenticates without switching its queued trusted journal to a session cache', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const original = await open(context);
  const uid = await account(original, 'restricted-' + randomUUID() + '@example.test', true, true);
  const restored = await open(context);
  assert.equal(await restored.evaluate(async () => (await window.observeUser())?.uid), uid);
  const reading = entry(randomUUID());
  await restored.evaluate(
    async ({ uid, reading }) => {
      const { databaseFor, firestore, journal } = window.kit;
      window.originalDatabase = await databaseFor(uid);
      await firestore.disableNetwork(window.originalDatabase);
      window.pending = journal.createReading(uid, reading);
      await journal.lockJournal(uid);
    },
    { uid, reading },
  );
  await restored.evaluate(denyJournalStorageReads);
  const locked = (page) => page.evaluate((uid) => window.kit.journal.isJournalLocked(uid), uid);
  const unlock = (secret) =>
    restored.evaluate(({ uid, secret }) => window.kit.journal.unlockJournal(uid, secret), {
      uid,
      secret,
    });
  assert.equal(await locked(restored), true);
  await assert.rejects(unlock('incorrect password'));
  assert.equal(await locked(restored), true);
  await unlock(password);
  assert.equal(await locked(restored), false);
  assert.equal(await locked(original), true);
  assert.equal(
    await restored.evaluate(async (uid) => {
      const { databaseFor, journal } = window.kit;
      return (
        journal.isOfflineJournalEnabled(uid) && (await databaseFor(uid)) === window.originalDatabase
      );
    }, uid),
    true,
    'The verified owner must keep the trusted Firestore queue',
  );

  // A new tab has no in-memory cache identity. It must use the original device cache or wait
  // for storage access rather than reading an empty session cache as a synced journal.
  await context.addInitScript(denyJournalStorageReads);
  const fresh = await open(context);
  assert.equal(await fresh.evaluate(async () => (await window.observeUser())?.uid), uid);
  const recovered = await fresh.evaluate(
    async ({ uid, password }) => {
      const { journal, databaseFor, firestore } = window.kit;
      try {
        await journal.unlockJournal(uid, password);
        const database = await databaseFor(uid);
        const rows = await firestore.getDocsFromCache(
          firestore.collection(database, 'users', uid, 'readings'),
        );
        return { ids: rows.docs.map((document) => document.get('id')) };
      } catch (error) {
        return { error: error.message };
      }
    },
    { uid, password },
  );
  if (recovered.error) assert.match(recovered.error, /storage|trusted|cache/i);
  else assert.deepEqual(recovered.ids, [reading.id]);

  await restored.evaluate(async () => {
    await window.kit.firestore.enableNetwork(window.originalDatabase);
    await window.pending;
  });
  await restored.evaluate(() => window.restoreStorage());
  assert.equal(await locked(restored), true);
});

test('an unlock with a full browser store refreshes the journal credentials and releases only that tab until relocked', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const first = await open(context);
  const uid = await account(first, 'quota-' + randomUUID() + '@example.test', true, true);
  const second = await open(context);
  assert.equal(await second.evaluate(async () => (await window.observeUser())?.uid), uid);
  const openSecondary = async (uid) => {
    const { databaseFor, getAuth } = window.kit;
    window.secondary = getAuth((await databaseFor(uid)).app);
  };
  await Promise.all([first.evaluate(openSecondary, uid), second.evaluate(openSecondary, uid)]);
  await first.evaluate(async (uid) => {
    const { journal } = window.kit;
    journal.observeJournalLock(uid, () => {});
    // Fill this isolated profile to its actual browser quota before the first lock.
    let filler = '';
    for (let size = 8 * 1024 * 1024; size >= 1; size /= 2) {
      const next = filler + 'x'.repeat(size);
      try {
        localStorage.setItem('quota-test', next);
        filler = next;
      } catch (error) {
        if (error.name !== 'QuotaExceededError') throw error;
      }
    }
    await journal.lockJournal(uid);
    // Keep the store full for the password check. A read-only browser also
    // rejects same-sized replacements, including Firebase's own auth writes.
    const setItem = Storage.prototype.setItem;
    let allowSmallAcknowledgment = false;
    Storage.prototype.setItem = function (key, value) {
      if (
        this === window.localStorage &&
        !(allowSmallAcknowledgment && key.startsWith('arcana.journal.unlock.'))
      ) {
        throw new DOMException('Browser storage full', 'QuotaExceededError');
      }
      return setItem.call(this, key, value);
    };
    window.allowAcknowledgment = () => {
      localStorage.removeItem('quota-test');
      allowSmallAcknowledgment = true;
    };
    window.restoreStorage = () => {
      Storage.prototype.setItem = setItem;
      localStorage.removeItem('quota-test');
    };
  }, uid);
  // Change the next ID token in a way we can observe without logging token values.
  const claimUpdate = await fetch(
    'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/demo-arcana-journal/accounts:update',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
      body: JSON.stringify({ localId: uid, customAttributes: JSON.stringify({ afterLock: true }) }),
    },
  );
  assert.ok(claimUpdate.ok, 'The test owner must have a distinguishable refreshed ID token');
  const unlock = () =>
    first.evaluate(({ uid, password }) => window.kit.journal.unlockJournal(uid, password), {
      uid,
      password,
    });
  const locked = (page) => page.evaluate((uid) => window.kit.journal.isJournalLocked(uid), uid);
  await assert.rejects(
    first.evaluate((uid) => window.kit.journal.unlockJournal(uid, 'wrong password'), uid),
  );
  assert.equal(await locked(first), true);
  await unlock();
  assert.equal(await locked(first), false);
  assert.equal(await locked(second), true);
  assert.equal(
    await first.evaluate(
      async () => (await window.secondary.currentUser.getIdTokenResult(true)).claims.afterLock,
    ),
    true,
  );
  const refreshed = async () => {
    const primary = await window.kit.getAuth().currentUser.getIdTokenResult();
    return (
      primary.claims.afterLock === true &&
      (await window.secondary.currentUser.getIdToken()) === primary.token
    );
  };
  await first.evaluate((uid) => window.kit.journal.lockJournal(uid), uid);
  assert.equal(await locked(first), true);
  const tabOnly = (page) =>
    page.evaluate((uid) => window.kit.journal.isJournalLockedInThisTabOnly(uid), uid);
  assert.equal(await tabOnly(first), true);
  assert.equal(await tabOnly(second), false);
  // A small lock acknowledgment can fit even while Firebase cannot persist
  // the refreshed session. Such a password check must still be limited to this tab.
  await first.evaluate(() => window.allowAcknowledgment());
  await unlock();
  assert.equal(await locked(first), false);
  assert.equal(await locked(second), true);
  await second.evaluate((uid) => window.kit.journal.lockJournal(uid), uid);
  await first.waitForFunction((uid) => window.kit.journal.isJournalLocked(uid), uid);
  await first.evaluate(() => window.restoreStorage());
  await unlock();
  assert.equal(await first.evaluate(refreshed), true);
  await second.waitForFunction(refreshed, undefined, { timeout: 5000 });
});

test('complete account export and clearing reach readings beyond the first cloud page', async () => {
  const context = await browser.newContext();
  const page = await open(context);
  const uid = await account(page, 'archive-' + randomUUID() + '@example.test', true, false);
  const result = await page.evaluate(
    async ({ uid, sample }) => {
      const { journal } = window.kit;
      const records = Array.from({ length: 101 }, (_, index) => ({
        ...sample,
        id: 'archive-' + index,
      }));
      await Promise.all(records.map((reading) => journal.createReading(uid, reading)));
      const exported = JSON.parse(await journal.exportAccountJournal(uid)).readings;
      await journal.clearReadings(uid);
      const cleared = JSON.parse(await journal.exportAccountJournal(uid)).readings;
      return { ids: exported.map((reading) => reading.id).sort(), countAfterClear: cleared.length };
    },
    { uid, sample: entry('template') },
  );
  assert.deepEqual(
    result.ids,
    Array.from({ length: 101 }, (_, index) => 'archive-' + index).sort(),
  );
  assert.equal(result.countAfterClear, 0);
  await context.close();
});

test('a trusted login survives a full browser store and reopens its device journal', async (t) => {
  const provisioning = await browser.newContext();
  const trusted = await browser.newContext();
  t.after(() => Promise.all([provisioning.close(), trusted.close()]));
  const email = 'trust-quota-' + randomUUID() + '@example.test';
  const uid = await account(await open(provisioning), email, true, false);
  const page = await open(trusted);
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      setItem.call(this, key, value);
      if (this !== localStorage || !key.startsWith('firebase:authUser:')) return;
      Storage.prototype.setItem = setItem;
      let filler = '';
      for (let size = 8 * 1024 * 1024; size >= 1; size /= 2) {
        const next = filler + 'x'.repeat(size);
        try {
          localStorage.setItem('quota-test', next);
          filler = next;
        } catch (error) {
          if (error.name !== 'QuotaExceededError') throw error;
        }
      }
    };
  });
  assert.equal(await account(page, email, false, true), uid);
  assert.equal(
    await page.evaluate((uid) => {
      try {
        localStorage.setItem('no-more-space', 'test');
        return false;
      } catch (error) {
        if (error.name !== 'QuotaExceededError') throw error;
      }
      return window.kit.journal.isOfflineJournalEnabled(uid);
    }, uid),
    true,
  );
  await page.evaluate(() => localStorage.removeItem('quota-test'));
  const reopened = await open(trusted);
  assert.equal(await reopened.evaluate(async () => (await window.observeUser())?.uid), uid);
  assert.equal(
    await reopened.evaluate(async (uid) => (await window.kit.databaseFor(uid)).app.name, uid),
    'journal-' + uid + '-device',
  );
  await reopened.evaluate((uid) => window.kit.journal.lockJournal(uid), uid);
  assert.equal(await page.evaluate((uid) => window.kit.journal.isJournalLocked(uid), uid), true);
});

test('a tab-only journal lock stays closed while its displayed owner changes', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await open(context);
  const owner = await account(page, 'lock-owner-' + randomUUID() + '@example.test', true, true);
  const sibling = await open(context);
  assert.equal((await sibling.evaluate(() => window.observeUser())).uid, owner);
  await page.evaluate(async (uid) => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('arcana.journal.lock.'))
        throw new DOMException('Read-only', 'SecurityError');
      return setItem.call(this, key, value);
    };
    try {
      await window.kit.journal.lockJournal(uid);
    } finally {
      Storage.prototype.setItem = setItem;
    }
    window.accountSwitchChecks = [];
    window.kit.journal.observeJournalLock(uid, () => {
      window.accountSwitchChecks.push({
        owner: window.kit.getAuth().currentUser?.uid ?? null,
        locked: window.kit.journal.isJournalLocked(uid),
      });
    });
  }, owner);
  assert.equal(
    await page.evaluate((uid) => window.kit.journal.isJournalLockedInThisTabOnly(uid), owner),
    true,
  );
  await sibling.evaluate((uid) => window.kit.journal.signOutAccount(uid), owner);
  const other = await account(sibling, 'lock-next-' + randomUUID() + '@example.test', true, true);
  await page.waitForFunction(
    (uid) => window.accountSwitchChecks.some((check) => check.owner === uid),
    other,
  );
  assert.equal(
    await page.evaluate(
      (uid) => window.accountSwitchChecks.every((check) => check.owner === uid || check.locked),
      owner,
    ),
    true,
  );
  assert.equal(await page.evaluate((uid) => window.kit.journal.isJournalLocked(uid), owner), true);
});

test('denied shared-login coordination keeps the journal hidden and permits a safe sign-out retry', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await open(context);
  const email = 'uncoordinated-' + randomUUID() + '@example.test';
  const uid = await account(page, email, true, true);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
    window.Worker = class {
      constructor() {
        throw new DOMException('Workers blocked', 'SecurityError');
      }
    };
  });
  await loadHarness(page);
  assert.equal((await page.evaluate(() => window.observeUser())).uid, uid);
  await assert.rejects(
    page.evaluate((uid) => window.kit.journal.signOutAccount(uid), uid),
    /coordinate|browser storage/i,
  );
  assert.equal((await page.evaluate(() => window.observeUser())).signOutIncomplete, true);
  const sibling = await open(context);
  assert.equal((await sibling.evaluate(() => window.observeUser())).uid, uid);
  await page.evaluate(() => {
    delete navigator.locks;
  });
  await page.evaluate((uid) => window.kit.journal.signOutAccount(uid), uid);
  assert.equal(await page.evaluate(() => window.observeUser()), null);
  const reopened = await open(context);
  assert.equal(await reopened.evaluate(() => window.observeUser()), null);
  // Restore the restricted environment on this tab without a stored login.
  await loadHarness(page);
  await assert.rejects(
    page.evaluate(({ email, password }) => window.kit.journal.signIn(email, password, true), {
      email,
      password,
    }),
    /coordinate/i,
  );
  assert.equal(await page.evaluate(() => window.kit.getAuth().currentUser), null);
  assert.equal(await account(page, email, false, false), uid);
  const shared = await open(context);
  assert.equal(await shared.evaluate(() => window.observeUser()), null);
});

test('an untagged interrupted sign-out clears a login saved by the previous app', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await open(context);
  const uid = await account(page, 'legacy-login-' + randomUUID() + '@example.test', true, true);
  await page.evaluate((uid) => {
    const key = window.kit.getAuth().persistenceManager.fullUserKey;
    const record = JSON.parse(localStorage.getItem(key));
    if (!record.arcanaLogin?.startsWith('login-')) throw new Error('Login generation is missing.');
    delete record.arcanaLogin;
    localStorage.setItem(key, JSON.stringify(record));
    sessionStorage.setItem(
      'arcana.journal.interrupted-sign-out.v1',
      JSON.stringify({ uid, trusted: true }),
    );
  }, uid);
  await loadHarness(page);
  assert.equal((await page.evaluate(() => window.observeUser())).signOutIncomplete, true);
  await page.evaluate((uid) => window.kit.journal.signOutAccount(uid), uid);
  assert.equal(await page.evaluate(() => window.kit.getAuth().currentUser), null);
  const reopened = await open(context);
  assert.equal(await reopened.evaluate(() => window.observeUser()), null);
});

test('a window without Web Locks cannot erase a simultaneous login in a native-lock tab', async (t) => {
  const context = await browser.newContext();
  const provisioning = await browser.newContext();
  t.after(() => Promise.all([context.close(), provisioning.close()]));
  const email = 'concurrent-login-' + randomUUID() + '@example.test';
  const replacement = await account(await open(provisioning), email, true, false);
  const original = await context.newPage();
  await original.addInitScript(() =>
    Object.defineProperty(navigator, 'locks', { value: undefined }),
  );
  await loadHarness(original);
  const uid = await account(
    original,
    'concurrent-signout-' + randomUUID() + '@example.test',
    true,
    true,
  );
  const sibling = await open(context);
  assert.equal((await sibling.evaluate(() => window.observeUser())).uid, uid);
  const lock = 'arcana.journal.login-storage';
  // Let the sign-in begin, then hold the storage lock until its credential
  // write and the original owner's deletion have both reached that lock.
  let resume;
  const passwordRequest = /\/accounts:signInWithPassword\?/;
  const started = sibling.waitForRequest(passwordRequest);
  const proceed = new Promise((resolve) => {
    resume = resolve;
  });
  await sibling.route(passwordRequest, async (route) => {
    await proceed;
    await route.continue();
  });
  await sibling.evaluate(
    ({ email, password }) => {
      window.nextLogin = window.kit.journal.signIn(email, password, true);
    },
    { email, password },
  );
  await started;
  await sibling.evaluate(
    (lock) =>
      new Promise((held) => {
        void navigator.locks.request(
          lock,
          () =>
            new Promise((release) => {
              window.releaseLoginStorage = release;
              held();
            }),
        );
      }),
    lock,
  );
  const queued = (count) =>
    sibling.waitForFunction(
      async ({ lock, count }) =>
        (await navigator.locks.query()).pending.filter(({ name }) => name === lock).length >= count,
      { lock, count },
    );
  resume();
  await queued(1);
  await original.evaluate((uid) => {
    window.oldSignOut = window.kit.journal.signOutAccount(uid);
  }, uid);
  await queued(2);
  await sibling.evaluate(() => window.releaseLoginStorage());
  await Promise.all([
    sibling.evaluate(() => window.nextLogin),
    original.evaluate(() => window.oldSignOut),
  ]);
  const reopened = await open(context);
  assert.equal((await reopened.evaluate(() => window.observeUser()))?.uid, replacement);
});

test('only the successfully authenticated account moves into the selected browser storage', async (t) => {
  const context = await browser.newContext();
  const provision = await browser.newContext();
  t.after(() => Promise.all([context.close(), provision.close()]));
  const page = await open(context);
  const email = 'session-owner-' + randomUUID() + '@example.test';
  const original = await account(page, email, true, false);
  const sibling = await open(context);
  assert.equal(await sibling.evaluate(() => window.observeUser()), null);
  await sibling.evaluate(() => {
    const key = window.kit.getAuth().persistenceManager.fullUserKey;
    window.publishedUsers = [];
    window.addEventListener('storage', (event) => {
      if (event.key === key && event.newValue)
        window.publishedUsers.push(JSON.parse(event.newValue).uid);
    });
  });
  await assert.rejects(
    page.evaluate((email) => window.kit.journal.signIn(email, 'wrong-password', true), email),
  );
  assert.equal(
    await page.evaluate((uid) => window.kit.journal.isOfflineJournalEnabled(uid), original),
    false,
  );
  const replacementEmail = 'replacement-' + email;
  const replacement = await account(await open(provision), replacementEmail, true, false);
  assert.equal(await account(page, replacementEmail, false, true), replacement);
  await sibling.waitForFunction((uid) => window.publishedUsers.includes(uid), replacement);
  assert.deepEqual(await sibling.evaluate(() => [...new Set(window.publishedUsers)]), [
    replacement,
  ]);
  assert.equal(await account(page, email, false, false), original);
  const fresh = await open(context);
  assert.equal(await fresh.evaluate(() => window.observeUser()), null);
  await loadHarness(page);
  assert.equal((await page.evaluate(() => window.observeUser()))?.uid, original);
});

test('Firebase clears a disabled owner from storage on refresh and on browser startup', async (t) => {
  const active = await browser.newContext();
  const closed = await browser.newContext();
  t.after(() => Promise.all([active.close(), closed.close()]));
  const email = 'disabled-owner-' + randomUUID() + '@example.test';
  const page = await open(active);
  const uid = await account(page, email, true, true);
  const previous = await open(closed);
  assert.equal(await account(previous, email, false, true), uid);
  await previous.close();
  const update = await fetch(
    'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/demo-arcana-journal/accounts:update',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
      body: JSON.stringify({ localId: uid, disableUser: true }),
    },
  );
  assert.ok(update.ok);
  await assert.rejects(
    page.evaluate(() => window.kit.journal.refreshAccount()),
    /disabled/,
  );
  const reopened = await open(closed);
  for (const tab of [page, reopened]) {
    assert.equal(await tab.evaluate(() => window.observeUser()), null);
    assert.equal(
      await tab.evaluate(() =>
        localStorage.getItem(window.kit.getAuth().persistenceManager.fullUserKey),
      ),
      null,
    );
  }
});

for (const sameAccount of [false, true])
  test(
    'a delayed observing tab preserves a new trusted login for the ' +
      (sameAccount ? 'same' : 'other') +
      ' account',
    async (t) => {
      const context = await browser.newContext();
      t.after(() => context.close());
      const sibling = await open(context);
      const email = 'observed-login-' + randomUUID() + '@example.test';
      const uid = await account(sibling, email, true, true);
      const observer = await open(context);
      assert.equal((await observer.evaluate(() => window.observeUser())).uid, uid);
      await observer.evaluate(() => {
        const key = window.kit.getAuth().persistenceManager.fullUserKey;
        window.observedLoginRemoval = new Promise((resolve) => {
          const removed = (event) => {
            if (event.key === key && event.newValue === null) {
              window.removeEventListener('storage', removed);
              resolve();
            }
          };
          window.addEventListener('storage', removed);
        });
        // Hold this tab's ordinary credential refresh before it takes the shared
        // lock, leaving the sibling free to publish both changes in sequence.
        const request = navigator.locks.request.bind(navigator.locks);
        window.refreshPaused = new Promise((paused) => {
          navigator.locks.request = async (name, ...args) => {
            if (name === 'arcana.journal.login-storage') {
              navigator.locks.request = request;
              await new Promise((resume) => {
                window.resumeRefresh = resume;
                paused();
              });
            }
            return request(name, ...args);
          };
        });
        window.refreshFinished = window.kit.journal.refreshAccount().catch(() => {});
      });
      await observer.evaluate(() => window.refreshPaused);
      await sibling.evaluate((uid) => window.kit.journal.signOutAccount(uid), uid);
      await observer.evaluate(() => window.observedLoginRemoval);
      const replacement = await account(
        sibling,
        sameAccount ? email : 'new-' + email,
        !sameAccount,
        true,
      );
      const generation = await sibling.evaluate(() => {
        const key = window.kit.getAuth().persistenceManager.fullUserKey;
        return JSON.parse(localStorage.getItem(key)).arcanaLogin;
      });
      await observer.evaluate(async () => {
        window.resumeRefresh();
        await window.refreshFinished;
        await window.kit.getAuth().operations;
      });
      const reopened = await open(context);
      assert.equal((await reopened.evaluate(() => window.observeUser()))?.uid, replacement);
      assert.equal(
        await reopened.evaluate(() => {
          const key = window.kit.getAuth().persistenceManager.fullUserKey;
          return JSON.parse(localStorage.getItem(key)).arcanaLogin;
        }),
        generation,
      );
      await observer.waitForFunction(
        (uid) => window.kit.getAuth().currentUser?.uid === uid,
        replacement,
      );
    },
  );

for (const replace of ['original', 'other account', 'same account'])
  test(
    replace !== 'original'
      ? 'retry of an interrupted owner sign-out preserves a newer trusted login for the ' + replace
      : 'an interrupted sign-out stays hidden through reload until Firebase removes its saved session',
    async (t) => {
      const context = await browser.newContext();
      t.after(() => context.close());
      await context.addInitScript(() =>
        Object.defineProperty(window, 'indexedDB', { value: undefined }),
      );
      const page = await open(context);
      // This tab must coordinate its removal with ordinary tabs even when its
      // window lacks Web Locks. The origin's lock remains available to workers.
      await page.addInitScript(() =>
        Object.defineProperty(navigator, 'locks', { value: undefined }),
      );
      await loadHarness(page);
      const email = 'partial-signout-' + randomUUID() + '@example.test';
      const uid = await account(page, email, true, true);
      await page.evaluate(async (uid) => {
        await window.kit.firestore.waitForPendingWrites(await window.kit.databaseFor(uid));
        const remove = Storage.prototype.removeItem;
        Storage.prototype.removeItem = function (key) {
          if (this === localStorage) throw new DOMException('Read-only', 'SecurityError');
          return remove.call(this, key);
        };
      }, uid);
      await assert.rejects(page.evaluate(() => window.kit.journal.signOutAccount()));
      const interrupted = { uid, email: null, emailVerified: false, signOutIncomplete: true };
      assert.deepEqual(await page.evaluate(() => window.observeUser()), interrupted);
      await assert.rejects(page.evaluate(() => window.kit.journal.signOutAccount()));
      assert.deepEqual(await page.evaluate(() => window.observeUser()), interrupted);
      // On reload, unreadable local storage makes Firebase select session storage instead.
      await page.addInitScript(() => {
        for (const name of ['getItem', 'setItem', 'removeItem']) {
          const original = Storage.prototype[name];
          Storage.prototype[name] = function (...args) {
            if (this === localStorage && !window.allowStorage)
              throw new DOMException('Storage is unavailable', 'SecurityError');
            return original.apply(this, args);
          };
        }
      });
      await loadHarness(page);
      assert.deepEqual(await page.evaluate(() => window.observeUser()), interrupted);
      assert.equal(await page.evaluate(() => window.kit.getAuth().currentUser), null);
      await assert.rejects(page.evaluate(() => window.kit.journal.signOutAccount()));
      assert.deepEqual(await page.evaluate(() => window.observeUser()), interrupted);
      let replacement;
      let sibling;
      if (replace !== 'original') {
        sibling = await open(context);
        await sibling.evaluate((uid) => window.kit.journal.signOutAccount(uid), uid);
        replacement = await account(
          sibling,
          replace === 'same account' ? email : 'replacement-' + randomUUID() + '@example.test',
          replace !== 'same account',
          true,
        );
      }
      await page.evaluate(() => (window.allowStorage = true));
      await page.evaluate((uid) => window.kit.journal.signOutAccount(uid), uid);
      assert.equal(await page.evaluate(() => window.observeUser()), null);
      const reopened = await open(context);
      if (replace !== 'original') {
        assert.equal((await reopened.evaluate(() => window.observeUser())).uid, replacement);
        if (replace !== 'same account')
          await reopened.evaluate((uid) => window.kit.journal.signOutAccount(uid), uid);
        assert.equal((await sibling.evaluate(() => window.observeUser())).uid, replacement);
        assert.equal((await reopened.evaluate(() => window.observeUser())).uid, replacement);
      } else {
        assert.equal(await reopened.evaluate(() => window.observeUser()), null);
        assert.equal(await account(reopened, email, false, true), uid);
      }
    },
  );

test('a shared-device login ignores an old trusted marker across a tab reload', async (t) => {
  const provisioning = await browser.newContext();
  const shared = await browser.newContext();
  t.after(() => Promise.all([provisioning.close(), shared.close()]));
  const email = 'trust-optout-' + randomUUID() + '@example.test';
  const uid = await account(await open(provisioning), email, true, false);
  const previous = await open(shared);
  await previous.evaluate(
    (uid) => localStorage.setItem('arcana.journal.trusted.' + uid, 'yes'),
    uid,
  );
  await previous.close();
  await shared.addInitScript(() => {
    for (const name of ['setItem', 'removeItem']) {
      const original = Storage.prototype[name];
      Storage.prototype[name] = function (...args) {
        if (this === localStorage && !window.allowStorage)
          throw new DOMException('Read-only', 'SecurityError');
        return original.apply(this, args);
      };
    }
  });
  const page = await open(shared);
  assert.equal(await account(page, email, false, false), uid);
  const checkSession = async (uid) => {
    window.allowStorage = true;
    return {
      marker: localStorage.getItem('arcana.journal.trusted.' + uid),
      offline: window.kit.journal.isOfflineJournalEnabled(uid),
      journal: (await window.kit.databaseFor(uid)).app.name,
    };
  };
  const expected = { marker: 'yes', offline: false, journal: 'journal-' + uid + '-session' };
  assert.deepEqual(await page.evaluate(checkSession, uid), expected);
  await loadHarness(page);
  assert.equal(await page.evaluate(async () => (await window.observeUser())?.uid), uid);
  assert.deepEqual(await page.evaluate(checkSession, uid), expected);
});
