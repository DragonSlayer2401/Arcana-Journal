import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { expect } from '@playwright/test';

import {
  withApp,
  authenticate,
  importReadings,
  downloadReadings,
} from '../../../../../../test/emulator/journalBrowser.mjs';

const reading = (question, createdAt) => ({
  id: '1745066048000-0',
  question,
  createdAt,
  cards: [
    { cardId: 'major-00', orientation: 'upright' },
    { cardId: 'major-01', orientation: 'reversed' },
  ],
  revealed: [false, true],
});

test(
  'a backup imported in UTC opens and exports in Los Angeles, including a previously synced legacy timestamp',
  withApp(async (base, browser) => {
    const utc = await browser.newPage({ timezoneId: 'UTC', locale: 'en-US' });
    const pacific = await browser.newPage({ timezoneId: 'America/Los_Angeles', locale: 'en-US' });
    const email = randomUUID() + '@example.test';
    const password = randomUUID();
    await authenticate(base, utc, email, password, { signup: true });
    const legacy = reading('No offset in the backup', '2026-01-02T03:04:05');
    const offset = {
      ...reading('An explicit offset', '2026-07-02T06:00:00+05:30'),
      id: 'with-offset',
    };
    const old = {
      ...reading('Already synced by an older release', '2026-01-02T11:04:05Z'),
      id: 'previously-synced',
    };
    const abbreviatedOffset = {
      ...reading('An older text-format offset', 'Fri, 02 Jan 2026 03:04:05 GMT+5:30'),
      id: 'legacy-offset',
    };
    await importReadings(utc, [legacy, offset, old, abbreviatedOffset]);
    const uid = await utc.evaluate(async () => {
      const { observeAccount } = window.kit.journal;
      return new Promise((resolve) => {
        const stop = observeAccount((user) => {
          stop();
          resolve(user.uid);
        });
      });
    });
    const url = (id) =>
      'http://127.0.0.1:8080/v1/projects/demo-arcana-journal/databases/(default)/documents/users/' +
      uid +
      '/readings/' +
      createHash('sha256').update(id).digest('hex');
    const headers = { Authorization: 'Bearer owner' };
    const saved = await utc.request.get(url(legacy.id), { headers });
    assert.equal((await saved.json()).fields.createdAt.stringValue, '2026-01-02T03:04:05.000Z');
    // Old clients kept the source text plus the epoch from the writer's zone.
    const patch = await utc.request.patch(url(old.id) + '?updateMask.fieldPaths=createdAt', {
      headers,
      data: { fields: { createdAt: { stringValue: '2026-01-02T03:04:05' } } },
    });
    assert.ok(patch.ok());
    await authenticate(base, pacific, email, password);
    await expect(
      pacific.getByRole('button', { name: /Open reading: No offset in the backup, Jan 1, 2026/ }),
    ).toBeVisible();
    await expect(
      pacific.getByRole('button', {
        name: /Open reading: Already synced by an older release, Jan 2, 2026/,
      }),
    ).toBeVisible();
    await pacific.getByRole('button', { name: /Open reading: Already synced/ }).click();
    await pacific.getByRole('button', { name: 'Reveal card 1', exact: true }).click();
    await pacific.getByRole('link', { name: /^Journal/ }).click();
    const rows = await downloadReadings(pacific, 'Export journal');
    assert.equal(rows.length, 4);
    assert.deepEqual(
      rows.find((row) => row.id === legacy.id),
      { ...legacy, createdAt: '2026-01-02T03:04:05.000Z' },
    );
    assert.deepEqual(
      rows.find((row) => row.id === offset.id),
      { ...offset, createdAt: '2026-07-02T00:30:00.000Z' },
    );
    assert.deepEqual(
      rows.find((row) => row.id === old.id),
      { ...old, createdAt: '2026-01-02T11:04:05.000Z', revealed: [true, true] },
    );
    assert.deepEqual(
      rows.find((row) => row.id === abbreviatedOffset.id),
      { ...abbreviatedOffset, createdAt: '2026-01-01T21:34:05.000Z' },
    );
  }),
);

test(
  'a merged account backup restores twice onto either original without duplicating a legacy draw',
  withApp(async (base, browser) => {
    const owner = await browser.newPage();
    await authenticate(base, owner, randomUUID() + '@example.test', randomUUID(), {
      signup: true,
    });
    const a = reading('Legacy reading A', '2026-01-02T03:04:05.000Z');
    const b = { ...a, question: 'Legacy reading B' };
    await importReadings(owner, [a]);
    await importReadings(owner, [b]);
    const merged = await downloadReadings(owner, 'Export journal');
    assert.equal(merged.length, 2);
    assert.equal(merged.find((row) => row.question === b.question).sourceId, b.id);
    // A different portable ID can legitimately hold the very same spread.
    // Import and re-import it beside a previously remapped reading.
    const independent = { ...b, id: 'different-origin', revealed: [true, false] };
    await importReadings(owner, [independent]);
    await importReadings(
      owner,
      [independent],
      'Imported 0 readings. Skipped 1 reading already in your journal.',
    );
    const all = await downloadReadings(owner, 'Export journal');
    assert.equal(all.length, 3);
    assert.deepEqual(
      all.find((row) => row.id === independent.id),
      independent,
    );
    assert.deepEqual(all.find((row) => row.sourceId === b.id)?.revealed, b.revealed);
    for (const original of [a, b]) {
      const dest = await browser.newPage();
      await authenticate(base, dest, randomUUID() + '@example.test', randomUUID(), {
        signup: true,
      });
      await importReadings(dest, [{ ...original, revealed: [true, false] }]);
      await importReadings(
        dest,
        merged,
        'Imported 1 reading. Updated reveal progress for 1 reading.',
      );
      for (let pass = 0; pass < 2; pass++) {
        if (pass)
          await importReadings(
            dest,
            merged,
            'Imported 0 readings. Skipped 2 readings already in your journal.',
          );
        await dest.reload();
        await expect(dest.getByRole('button', { name: /^Open reading:/ })).toHaveCount(2);
        const restored = await downloadReadings(dest, 'Export journal');
        assert.deepEqual(restored.map((row) => row.question).sort(), [a.question, b.question]);
        assert.deepEqual(restored.find((row) => row.id === original.id).revealed, [true, true]);
      }
      await dest.close();
    }
  }),
);
