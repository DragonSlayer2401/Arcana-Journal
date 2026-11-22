import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DECK } from '../data/deck';
import {
  backupNeedsSizeConfirmation,
  collisionReadingId,
  createJournalBackup,
  mergeJournalReadings,
  parseJournalBackup,
} from './journalBackup';
import type { Reading } from './types';

const reading = (id: string, createdAt = '2026-11-19T17:23:45.678Z'): Reading => ({
  id,
  createdAt,
  question: 'What’s next?\n今日 ✨',
  cards: [
    { cardId: DECK[7].id, orientation: 'reversed' },
    { cardId: DECK[4].id, orientation: 'upright' },
  ],
  revealed: [false, true],
});

describe('portable journal backups', () => {
  beforeEach(() => vi.stubGlobal('crypto', webcrypto));
  afterEach(() => vi.unstubAllGlobals());

  it('exports every page in order and round trips exactly the portable reading fields', async () => {
    const first = reading('first');
    const second = { ...reading('second'), question: '' };
    const withMetadata = {
      ...first,
      accountId: 'private',
      cards: first.cards.map((card) => ({ ...card, internal: true })),
    };
    const readPage = vi
      .fn()
      .mockResolvedValueOnce({ readings: [withMetadata], nextCursor: 'after-first' })
      .mockResolvedValueOnce({ readings: [], nextCursor: 'after-empty' })
      .mockResolvedValueOnce({ readings: [second], nextCursor: null });

    const json = await createJournalBackup(readPage);
    expect(readPage.mock.calls).toEqual([[null], ['after-first'], ['after-empty']]);
    expect(JSON.parse(json)).toEqual({ version: 1, readings: [first, second] });
    expect(parseJournalBackup(json)).toEqual([first, second]);
  });

  it('can export and restore an empty journal', async () => {
    const json = await createJournalBackup(() => ({ readings: [], nextCursor: null }));
    expect(parseJournalBackup(json)).toEqual([]);
  });

  it.each([
    ['2026-11-19T11:23:45.678', '2026-11-19T11:23:45.678Z'],
    ['2026-11-19 11:23:45', '2026-11-19T11:23:45.000Z'],
    ['2026-11-19', '2026-11-19T00:00:00.000Z'],
    ['2026-11-19T11:23:45.678-06:00', '2026-11-19T17:23:45.678Z'],
    ['Fri, 02 Jan 2026 03:04:05 GMT+5:30', '2026-01-01T21:34:05.000Z'],
    ['Fri, 02 Jan 2026 03:04:05 UTC+5', '2026-01-01T22:04:05.000Z'],
    ['Fri, 02 Jan 2026 03:04:05 -7', '2026-01-02T10:04:05.000Z'],
    ['Fri, 02 Jan 2026 03:04:05+530', '2026-01-01T21:34:05.000Z'],
    ['Jan-02-26', '2026-01-02T00:00:00.000Z'],
  ])('imports and exports %s as UTC', async (input, expected) => {
    const original = reading('legacy-date', input);
    const fromFile = parseJournalBackup(JSON.stringify({ version: 1, readings: [original] }));
    const exported = await createJournalBackup(() => ({ readings: [original], nextCursor: null }));
    expect(fromFile[0].createdAt).toBe(expected);
    expect(JSON.parse(exported).readings[0].createdAt).toBe(expected);
  });

  it('propagates a later page failure without producing an incomplete backup', async () => {
    const readPage = vi
      .fn()
      .mockResolvedValueOnce({ readings: [reading('first')], nextCursor: 'next' })
      .mockRejectedValueOnce(new Error('Offline'));
    await expect(createJournalBackup(readPage)).rejects.toThrow('Offline');
  });

  it.each([
    ['repeated cursor', { readings: [], nextCursor: 'next' }, /repeated page/],
    ['overlapping results', { readings: [reading('first')], nextCursor: null }, /duplicate/],
    ['absent cursor', { readings: [] }, /invalid page/],
    ['absent collection', { nextCursor: null }, /list of readings/],
  ] as const)('rejects an incomplete export with %s', async (_, badPage, error) => {
    const readPage = vi
      .fn()
      .mockResolvedValueOnce({ readings: [reading('first')], nextCursor: 'next' })
      .mockResolvedValueOnce(badPage);
    await expect(createJournalBackup(readPage)).rejects.toThrow(error);
    expect(readPage).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['malformed JSON', '{', /JSON/],
    ['missing version', '{"readings":[]}', /version/],
    ['future version', '{"version":2,"readings":[]}', /unsupported/],
    ['missing collection', '{"version":1}', /list of readings/],
    ['invalid collection', '{"version":1,"readings":null}', /list of readings/],
  ] as const)('rejects %s', (_, json, error) => {
    expect(() => parseJournalBackup(json)).toThrow(error);
  });

  it.each([
    ['blank ID', { id: ' ' }],
    ['invalid date', { createdAt: 'not a date' }],
    ['missing question', { question: null }],
    ['empty spread', { cards: [], revealed: [] }],
    ['unknown card', { cards: [{ cardId: 'unknown', orientation: 'upright' }], revealed: [false] }],
    ['bad orientation', { cards: [{ cardId: DECK[0].id, orientation: 'down' }], revealed: [true] }],
    ['duplicate card', { cards: [reading('r').cards[0], reading('r').cards[0]] }],
    ['misaligned reveal flags', { revealed: [true] }],
    ['invalid reveal flag', { revealed: [true, 1] }],
  ] as const)('rejects the entire file if a later reading has %s', (_, invalid) => {
    const json = JSON.stringify({
      version: 1,
      readings: [reading('good'), { ...reading('bad'), ...invalid }],
    });
    expect(() => parseJournalBackup(json)).toThrow(/Reading 2/);
  });

  it('rejects duplicate IDs inside a backup and strips extra fields from valid imports', () => {
    const original = reading('one');
    const duplicate = JSON.stringify({ version: 1, readings: [original, original] });
    expect(() => parseJournalBackup(duplicate)).toThrow(/duplicate reading ID/);
    const extra = JSON.stringify({ version: 1, readings: [{ ...original, accountId: 'private' }] });
    expect(parseJournalBackup(extra)).toEqual([original]);
  });

  it('merges chronologically and keeps local progress across repeated imports', async () => {
    const latest = reading('latest', '2026-11-19T20:00:00Z');
    const local = { ...reading('existing'), revealed: [true, true] };
    const oldest = reading('oldest', '2026-11-18T20:00:00Z');
    const incoming = [oldest, { ...local, revealed: [false, false] }, latest];

    const result = await mergeJournalReadings([local], incoming);
    expect(result).toEqual({ readings: [latest, local, oldest], added: 2, skipped: 1, updated: 0 });
    expect(await mergeJournalReadings(result.readings, incoming)).toEqual({
      readings: result.readings,
      added: 0,
      skipped: 3,
      updated: 0,
    });
  });

  it('accepts original browser storage without transferring settings or the open reading', () => {
    const original = reading('1745066048000-2');
    expect(
      parseJournalBackup(
        JSON.stringify({
          version: 1,
          activeId: original.id,
          awaitingNewReading: true,
          settings: { mode: 'one' },
          readings: [original],
        }),
      ),
    ).toEqual([original]);
  });

  it('merges reveal progress in either direction without changing the original timestamp', async () => {
    const local = { ...reading('match'), revealed: [true, false] };
    const fromFile = {
      ...local,
      createdAt: new Date(local.createdAt).toISOString(),
      revealed: [false, true],
    };
    const { readings, added, skipped, updated } = await mergeJournalReadings([local], [fromFile]);
    expect({ added, skipped, updated }).toEqual({ added: 0, skipped: 0, updated: 1 });
    expect(readings).toEqual([{ ...local, revealed: [true, true] }]);
    expect(local.revealed).toEqual([true, false]);
  });

  it('preserves same-ID legacy draws and recognizes a repeated file after the first draw is removed', async () => {
    const local = reading('1745066048000-1');
    const secondDraw = { ...local, question: 'A different reflection' };
    const firstImport = await mergeJournalReadings([local], [secondDraw]);
    expect(firstImport.added).toBe(1);
    const alternate = firstImport.readings.find(({ id }) => id !== local.id)!;
    expect(alternate).toEqual({
      ...secondDraw,
      id: expect.stringMatching(/^import-[a-f0-9]{64}$/),
      sourceId: local.id,
    });
    const progressed = [{ ...secondDraw, revealed: [true, false] }];
    const retry = await mergeJournalReadings([alternate], progressed);
    expect(retry).toEqual({
      added: 0,
      skipped: 0,
      updated: 1,
      readings: [{ ...alternate, revealed: [true, true] }],
    });
  });

  it.each([false, true])(
    'restores a merged backup onto either original, legacy file: %s',
    async (legacy) => {
      const a = { ...reading('shared-legacy-id'), question: 'Reading A' };
      const b = { ...a, question: 'Reading B' };
      const merged = await mergeJournalReadings([a], [b]);
      const json = await createJournalBackup(() => ({
        readings: merged.readings,
        nextCursor: null,
      }));
      const backup = parseJournalBackup(json);
      if (legacy) backup.forEach((row) => delete row.sourceId);
      for (const original of [a, b]) {
        for (const rows of [backup, [...backup].reverse()]) {
          const prior = { ...original, revealed: [true, false] };
          const result = await mergeJournalReadings([prior], rows);
          expect(result.readings.map((r) => r.question).sort()).toEqual(['Reading A', 'Reading B']);
          expect(result.readings.find((r) => r.id === prior.id)?.revealed).toEqual([true, true]);
          expect((await mergeJournalReadings(result.readings, rows)).readings).toBe(
            result.readings,
          );
        }
      }
    },
  );

  it('keeps both readings if a backup already contains the first alternate ID', async () => {
    const local = reading('primary');
    const incoming = { ...local, cards: [...local.cards].reverse() };
    const occupied = { ...local, id: await collisionReadingId(incoming) };
    const { readings } = await mergeJournalReadings([local, occupied], [incoming]);
    expect(readings).toHaveLength(3);
    const retry = await mergeJournalReadings(readings, [incoming]);
    expect(retry.readings).toBe(readings);
    expect(retry.skipped).toBe(1);
    const afterDelete = readings.filter((r) => r.id !== occupied.id);
    expect((await mergeJournalReadings(afterDelete, [incoming])).readings).toBe(afterDelete);
  });

  it('reuses a historical collision ID after the earlier occupants are removed', async () => {
    const original = reading('legacy-source');
    const prior = { ...original, id: await collisionReadingId(original, 2) };
    const imported = await mergeJournalReadings([prior], [{ ...original, revealed: [true, true] }]);
    expect(imported.added).toBe(0);
    expect(imported.readings).toEqual([{ ...prior, revealed: [true, true] }]);
  });

  it('keeps an ambiguous historical collision for explicit review', async () => {
    const original = reading('legacy-source');
    const prior = { ...original, id: await collisionReadingId(original, 73) };
    await expect(mergeJournalReadings([prior], [original])).rejects.toThrow(
      /original ID could not be verified/,
    );
  });

  it('uses a recorded origin on an opaque historical alternate and admits an independent reading with identical content', async () => {
    const source = reading('legacy-id');
    const assigned = { ...source, id: await collisionReadingId(source, 73), sourceId: source.id };
    const progress = { ...source, revealed: [true, true] };
    const updated = await mergeJournalReadings([assigned], [progress]);
    expect(updated.readings).toEqual([{ ...assigned, revealed: [true, true] }]);
    const other = { ...source, id: 'independent-origin' };
    const merged = await mergeJournalReadings([assigned], [other]);
    expect(merged.readings).toEqual([assigned, other]);
    expect((await mergeJournalReadings(merged.readings, [other])).skipped).toBe(1);
  });

  it.each(['unrecorded time zone', 'unrecorded collision attempt'])(
    'requests review of an old merged backup when the original hash used an %s',
    async (reason) => {
      const original = reading('legacy-id', '2026-01-02T03:04:05');
      const other = { ...original, question: 'Other spread at the same ID' };
      const hashed =
        reason === 'unrecorded time zone'
          ? await collisionReadingId({ ...original, createdAt: '2026-01-02T03:04:05-08:00' })
          : await collisionReadingId(original, 73);
      const alternate = { ...original, id: hashed };
      for (const rows of [
        [other, alternate],
        [alternate, other],
      ]) {
        const incoming = parseJournalBackup(JSON.stringify({ version: 1, readings: rows }));
        await expect(mergeJournalReadings([original], incoming)).rejects.toThrow(
          /original ID could not be verified/,
        );
      }
      // A file containing the lone opaque ID provides no conflicting primary.
      expect((await mergeJournalReadings([original], [alternate])).added).toBe(1);
    },
  );

  it.each([false, true])(
    'round trips two explicitly distinct backup rows, alternate first: %s',
    async (alternateFirst) => {
      const original = reading('portable-legacy-pair');
      const alternate = {
        ...original,
        id: await collisionReadingId(original, 73),
        revealed: [true, false],
      };
      const rows = alternateFirst ? [alternate, original] : [original, alternate];
      const backup = await createJournalBackup(() => ({ readings: rows, nextCursor: null }));
      const restored = await mergeJournalReadings([], parseJournalBackup(backup));
      expect(restored.added).toBe(2);
      expect(restored.readings).toEqual(rows);
      expect((await mergeJournalReadings(restored.readings, rows)).readings).toEqual(rows);
    },
  );

  it('flags large files for confirmation before reading them', () => {
    expect(backupNeedsSizeConfirmation(64 * 1024 * 1024)).toBe(false);
    expect(backupNeedsSizeConfirmation(64 * 1024 * 1024 + 1)).toBe(true);
  });

  it('preserves an explicitly listed primary and alternate even after identical content is recreated at the primary ID', async () => {
    const primary = reading('legacy');
    const alternate = { ...primary, id: await collisionReadingId(primary), sourceId: primary.id };
    for (const rows of [
      [primary, alternate],
      [alternate, primary],
    ]) {
      const restored = await mergeJournalReadings([], rows);
      expect(restored.readings).toEqual(rows);
      expect((await mergeJournalReadings(restored.readings, rows)).readings).toBe(
        restored.readings,
      );
    }
  });
});
