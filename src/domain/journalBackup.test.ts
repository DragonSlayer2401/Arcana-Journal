import { describe, expect, it, vi } from 'vitest';
import { DECK } from '../data/deck';
import { createJournalBackup, mergeJournalReadings, parseJournalBackup } from './journalBackup';
import type { Reading } from './types';

const reading = (id: string, createdAt = '2026-11-19T11:23:45.678-06:00'): Reading => ({
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

  it('merges chronologically and keeps local progress across repeated imports', () => {
    const latest = reading('latest', '2026-11-19T20:00:00Z');
    const local = { ...reading('existing'), revealed: [true, true] };
    const oldest = reading('oldest', '2026-11-18T20:00:00Z');
    const incoming = [oldest, { ...local, revealed: [false, false] }, latest];

    const result = mergeJournalReadings([local], incoming);
    expect(result).toEqual({ readings: [latest, local, oldest], added: 2, skipped: 1 });
    expect(mergeJournalReadings(result.readings, incoming)).toEqual({
      readings: result.readings,
      added: 0,
      skipped: 3,
    });
  });
});
