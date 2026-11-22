import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { chromium, expect } from '@playwright/test';
import {
  withApp,
  authenticate,
  downloadReadings,
  importReadings,
} from '../../../../../../test/emulator/journalBrowser.mjs';

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
