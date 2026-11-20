import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

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

const open = async (context) => {
  const page = await context.newPage();
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
const account = async (page, email, create, trusted) =>
  page.evaluate(
    async (args) => {
      const { journal } = window.kit;
      if (args.create) await journal.signUp(args.email, args.password, args.trusted);
      else await journal.signIn(args.email, args.password, args.trusted);
      const user = await window.observeUser();
      return user.uid;
    },
    { email, password, create, trusted },
  );

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
    async ({ uid, id }) => {
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
      window.offlineReveal = journal.revealCards(uid, id, [0]);
    },
    { uid, id: reading.id },
  );
  await device.waitForFunction(() => window.firstPage?.status.fromCache);
  await laptop.evaluate(async ({ uid, id }) => window.kit.journal.revealCards(uid, id, [1]), {
    uid,
    id: reading.id,
  });
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
        journal.revealCards(uid, next.id, [0]),
      ]);
      await firestore.enableNetwork(database);
      await pending;
    },
    { uid, next },
  );
  await laptop.evaluate(async ({ uid, id }) => window.kit.journal.removeReading(uid, id), {
    uid,
    id: next.id,
  });
  await assert.rejects(
    device.evaluate(async ({ uid, id }) => window.kit.journal.revealCards(uid, id, [1]), {
      uid,
      id: next.id,
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
