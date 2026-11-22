import { draw, pendingWrite, trustedCache } from '../helpers/unsyncedJournal';
import { isOfflineJournalEnabled } from '@/services/Account/account.service';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  createReading,
  lookupRecoveryReading,
  observeReadings,
  removeReading,
  revealCards,
} from '@/services/Journal/journal.service';
import {
  loadRecoveryCopies,
  prepareRecoveryDeletion,
  importTargetRecorder,
  saveRecoveryCopy,
} from '@/features/Journal/features/AccountJournal/utils/readingRecovery';
import { collisionReadingId } from '@/features/Journal/utils/journalBackup';
import { useAccountJournal } from '@/features/Journal/features/AccountJournal/hooks/useAccountJournal';

describe('retrying a failed journal write', () => {
  it('retries failed reveals as updates and clears them when another device deleted the reading', async () => {
    trustedCache([draw]);
    vi.mocked(revealCards)
      .mockRejectedValueOnce(new Error('Unavailable'))
      .mockRejectedValueOnce({ code: 'not-found' });
    const { result } = renderHook(() => useAccountJournal('tester', draw.id));
    await act(async () => result.current.reveal(draw.id, [1]));
    expect(result.current.syncError).toContain('Unavailable');
    expect(result.current.recoveryReadings).toEqual([{ ...draw, revealed: [false, true] }]);
    expect(result.current.savedRecovery.readings).toEqual([]); // The active tab can retry this failed reveal.
    await act(async () => result.current.retrySync());
    await waitFor(() => expect(result.current.syncError).toBe(''));
    expect(revealCards).toHaveBeenCalledTimes(2);
    expect(createReading).not.toHaveBeenCalled();
    expect(result.current.savedRecovery.readings).toEqual([]);
    expect(result.current.recoveryReadings).toEqual([]);
  });

  it('offers the original spread for recovery when the ID changes hands before retry', async () => {
    const replacement = { ...draw, question: 'An imported spread with the same ID' };
    trustedCache([draw]);
    vi.mocked(revealCards).mockRejectedValueOnce(new Error('Unavailable'));
    const { result } = renderHook(() => useAccountJournal('tester', draw.id));
    await act(async () => result.current.reveal(draw.id, [1]));
    const publish = vi.mocked(observeReadings).mock.calls[0][2];
    act(() => publish([replacement], { fromCache: false, pending: false, hasMore: false }));
    trustedCache([replacement]); // Retry also subscribes again to the journal.
    await act(async () => result.current.retrySync());
    expect(revealCards).toHaveBeenCalledExactlyOnceWith('tester', draw, [1]);
    expect(result.current.active).toEqual(replacement);
    expect(result.current.savedRecovery.readings).toEqual([{ ...draw, revealed: [false, true] }]);
  });

  it('keeps a reveal assigned to another document when Firebase reports the original missing', async () => {
    const reveal = { ...draw, revealed: [true, false] };
    const alternate = { ...draw, id: await collisionReadingId(draw) };
    const key = saveRecoveryCopy('tester', reveal);
    await importTargetRecorder(loadRecoveryCopies('tester').copies, reveal)(alternate.id);
    trustedCache([draw, alternate]);
    vi.mocked(revealCards).mockRejectedValueOnce({ code: 'not-found' });
    const { result } = renderHook(() => useAccountJournal('tester', draw.id));
    await act(async () => result.current.reveal(draw.id, [1]));
    expect(loadRecoveryCopies('tester').copies).toEqual([
      { key, reading: reveal, importedAs: alternate.id },
    ]);
  });

  it.each([true, false])(
    'keeps a refused reveal for explicit owner recovery (trusted: %s)',
    async (trusted) => {
      trustedCache([draw]);
      vi.mocked(isOfflineJournalEnabled).mockReturnValue(trusted);
      vi.mocked(revealCards).mockRejectedValueOnce({ code: 'permission-denied' });
      const { result } = renderHook(() => useAccountJournal('tester', draw.id));
      await act(async () => result.current.reveal(draw.id, [0]));
      expect(result.current.savedRecovery.readings).toEqual([{ ...draw, revealed: [true, false] }]);
      expect(result.current.pending).toBe(false);
      if (!trusted) {
        expect(localStorage.length).toBe(0);
        expect(result.current.needsOpenTab).toBe(true);
      }
      act(() => result.current.savedRecovery.discard());
    },
  );

  it('waits for the original reading to acknowledge a reveal already present on its alternate', async () => {
    const pending = { ...draw, revealed: [true, false] };
    const alternate = { ...pending, id: await collisionReadingId(draw) };
    const pendingKey = saveRecoveryCopy('tester', pending);
    const alternateKey = saveRecoveryCopy('tester', alternate);
    vi.mocked(lookupRecoveryReading).mockResolvedValue(draw);
    vi.mocked(observeReadings).mockImplementation((_uid, _limit, onChange) => {
      onChange([alternate], { fromCache: false, pending: false, hasMore: true });
      return () => {};
    });
    const { result } = renderHook(() => useAccountJournal('tester', draw.id));
    await waitFor(() => expect(localStorage.getItem(alternateKey)).toBeNull());
    expect(lookupRecoveryReading).toHaveBeenCalledWith('tester', draw.id);
    expect(result.current.savedRecovery.readings).toEqual([pending]);
    const onChange = vi.mocked(observeReadings).mock.calls[0][2];
    act(() => onChange([pending, alternate], { fromCache: false, pending: false, hasMore: false }));
    await waitFor(() => expect(localStorage.getItem(pendingKey)).toBeNull());
  });

  it('follows a transaction retry without changing an independently saved copy', async () => {
    const key = saveRecoveryCopy('tester', draw);
    const recordTarget = importTargetRecorder(loadRecoveryCopies('tester').copies, draw);
    const first = await collisionReadingId(draw);
    await recordTarget(first);
    const separateKey = saveRecoveryCopy('tester', draw);
    await recordTarget(first + '-1');
    expect(loadRecoveryCopies('tester').copies).toEqual(
      expect.arrayContaining([
        { key, reading: draw, importedAs: first + '-1' },
        { key: separateKey, reading: draw },
      ]),
    );
    await recordTarget(draw.id);
    expect(loadRecoveryCopies('tester').copies.find((copy) => copy.key === key)?.importedAs).toBe(
      draw.id,
    );
  });

  it('reports unreadable recovery copies even after an empty server snapshot and finds them on retry', () => {
    const hiddenKey = saveRecoveryCopy('tester', draw);
    const visible = { ...draw, id: 'readable-copy' };
    saveRecoveryCopy('tester', visible);
    vi.mocked(isOfflineJournalEnabled).mockReturnValue(true);
    vi.mocked(observeReadings).mockImplementation((_uid, _limit, onChange) => {
      onChange([], { fromCache: false, pending: false, hasMore: false });
      return () => {};
    });
    const getItem = Storage.prototype.getItem;
    const denied = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (
      this: Storage,
      key: string,
    ) {
      if (key === hiddenKey) throw new DOMException('Storage unavailable', 'SecurityError');
      return getItem.call(this, key);
    });
    try {
      const { result } = renderHook(() => useAccountJournal('tester', null));
      expect(result.current.syncError).toMatch(/could not read every recovery copy/i);
      expect(result.current.status).toContain('needs attention');
      expect(result.current.savedRecovery.readings).toEqual([visible]);
      denied.mockRestore();
      act(() => result.current.retrySync());
      expect(result.current.syncError).toBe('');
      expect(result.current.savedRecovery.readings).toHaveLength(2);
      expect(result.current.savedRecovery.readings).toContainEqual(draw);
    } finally {
      denied.mockRestore();
    }
  });

  it.each(['missing', 'replaced'])(
    'keeps the assigned copy through acknowledgment and deletion of its identical source when the destination is %s',
    async (state) => {
      const revealed = { ...draw, revealed: [true, false] };
      const assignedId = await collisionReadingId(draw);
      const key = saveRecoveryCopy('tester', revealed);
      await importTargetRecorder(loadRecoveryCopies('tester').copies, revealed)(assignedId);
      const sourceKey = saveRecoveryCopy('tester', revealed);
      const replacement = { ...draw, id: assignedId, question: 'A different spread' };
      trustedCache(state === 'replaced' ? [revealed, replacement] : [revealed]);
      const { result } = renderHook(() => useAccountJournal('tester', draw.id));
      const publish = vi.mocked(observeReadings).mock.lastCall![2];
      const synced = { fromCache: false, pending: false, hasMore: false };
      await act(async () =>
        publish(state === 'replaced' ? [revealed, replacement] : [revealed], synced),
      );
      await waitFor(() => expect(localStorage.getItem(sourceKey)).toBeNull());
      expect(localStorage.getItem(key)).toBe(JSON.stringify(revealed));
      await act(async () => result.current.remove(draw.id));
      expect(removeReading).toHaveBeenCalledWith('tester', revealed);
      expect(localStorage.getItem(key)).toBe(JSON.stringify(revealed));
      const afterDelete = vi.mocked(observeReadings).mock.lastCall![2];
      await act(async () => afterDelete([{ ...revealed, id: assignedId }], synced));
      await waitFor(() => expect(localStorage.getItem(key)).toBeNull());
    },
  );

  it('keeps a recovery copy assigned elsewhere before the original write acknowledges', async () => {
    trustedCache([]);
    const write = pendingWrite();
    vi.mocked(createReading).mockReturnValueOnce(write.promise);
    const { result } = renderHook(() => useAccountJournal('tester', draw.id));
    act(() => result.current.saveDraw(draw));
    const { copies } = loadRecoveryCopies('tester');
    const assignedId = await collisionReadingId(draw);
    await importTargetRecorder(copies, draw)(assignedId);
    await act(async () => write.resolve());
    expect(loadRecoveryCopies('tester').copies).toEqual([
      { key: copies[0].key, reading: draw, importedAs: assignedId },
    ]);
  });

  it('keeps a recovery copy reassigned while an acknowledgment or deletion is being checked', async () => {
    const key = saveRecoveryCopy('tester', draw);
    const first = { ...draw, id: await collisionReadingId(draw) };
    const second = { ...draw, id: await collisionReadingId(first) };
    await importTargetRecorder(loadRecoveryCopies('tester').copies, draw)(first.id);
    const previous = loadRecoveryCopies('tester').copies;
    trustedCache([]);
    renderHook(() => useAccountJournal('tester', null));
    const publish = vi.mocked(observeReadings).mock.lastCall![2];
    await act(async () => {
      publish([first], { fromCache: false, pending: false, hasMore: false });
      await importTargetRecorder(loadRecoveryCopies('tester').copies, first)(second.id);
    });
    expect(() =>
      prepareRecoveryDeletion(previous.map((copy) => ({ ...copy, targetId: first.id }))),
    ).toThrow(/confirm again/i);
    expect(loadRecoveryCopies('tester').copies).toEqual([
      { key, reading: draw, importedAs: second.id },
    ]);
  });
});
