import { webcrypto } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { recoverGuestReadings } from './guestRecovery';
import { collisionReadingId } from './journalBackup';
import type { Reading } from './types';

const original: Reading = {
  id: 'legacy',
  question: 'Which path?',
  cards: [{ cardId: 'major-00', orientation: 'upright' }],
  revealed: [false],
  createdAt: '2026-11-20T12:00:00Z',
};
afterEach(() => vi.unstubAllGlobals());

it('keeps a replacement with a reused ID and preserves every explicit ID when naming the unsaved spread', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const edited = { ...original, revealed: [true] };
  const replacement = { ...original, question: 'A replacement' };
  const alternate = await collisionReadingId(edited);
  const separate = { ...original, id: alternate };
  const result = await recoverGuestReadings([original], [edited], [replacement, separate]);
  expect(result).toHaveLength(3);
  expect(result).toEqual(
    expect.arrayContaining([
      replacement,
      separate,
      { ...edited, id: alternate + '-1', sourceId: edited.id },
    ]),
  );
});

it('applies a local deletion to an unchanged spread and keeps a sibling edit to a deleted spread', async () => {
  const kept = { ...original, id: 'keep' };
  const updated = { ...kept, revealed: [true] };
  expect(await recoverGuestReadings([original, kept], [], [original, updated])).toEqual([updated]);
});
