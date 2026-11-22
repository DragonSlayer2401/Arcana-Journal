import { draw, pendingWrite, trustedCache } from '../helpers/unsyncedJournal';
import { isOfflineJournalEnabled } from '@/services/Account/account.service';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  clearReadings,
  observeReadings,
  readDeletionTarget,
  removeReading,
  revealCards,
} from '@/services/Journal/journal.service';
import {
  loadRecoveryCopies,
  prepareRecoveryDeletion,
  importTargetRecorder,
  saveRecoveryCopy,
} from '@/features/Journal/features/AccountJournal/utils/readingRecovery';
import { saveTabRecoveryCopy } from '@/features/Journal/features/AccountJournal/utils/tabRecovery';
import { collisionReadingId } from '@/features/Journal/utils/journalBackup';
import type { Reading } from '@/features/Journal/readingTypes';
import { useAccountJournal } from '@/features/Journal/features/AccountJournal/hooks/useAccountJournal';

describe('deleting a reading with local recovery copies', () => {
  it('requires a fresh delete choice after a failed deletion', async () => {
    trustedCache([draw]);
    vi.mocked(removeReading)
      .mockRejectedValueOnce(new Error('Denied'))
      .mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useAccountJournal('tester', draw.id));
    await act(async () => {
      await expect(result.current.remove(draw.id)).rejects.toThrow('Denied');
    });
    expect(result.current.deleteError).toContain('confirm again');
    expect(result.current.entries).toEqual([draw]);
    act(() => result.current.retrySync());
    expect(removeReading).toHaveBeenCalledTimes(1);
    await act(async () => result.current.remove(draw.id));
    expect(result.current.deleteError).toBe('');
  });

  it('deletes the displayed spread and keeps the other recovery copy with the same legacy ID', async () => {
    const displayed = { ...draw, question: 'The imported spread' };
    const originalKey = saveRecoveryCopy('tester', draw);
    const displayedKey = saveRecoveryCopy('tester', { ...displayed, revealed: [true, false] });
    trustedCache([displayed]);
    const { result, unmount } = renderHook(() => useAccountJournal('tester', draw.id));
    expect(result.current.active).toEqual(displayed);
    await act(async () => result.current.remove(draw.id));
    expect(removeReading).toHaveBeenCalledWith('tester', displayed);
    expect(localStorage.getItem(displayedKey)).toBeNull();
    expect(localStorage.getItem(originalKey)).toEqual(JSON.stringify(draw));
    unmount();
    const reopened = renderHook(() => useAccountJournal('tester', null));
    expect(reopened.result.current.savedRecovery.readings).toEqual([draw]);
  });

  it('leaves the reveal belonging to the assigned import when an identical duplicate is deleted', async () => {
    const source = { ...draw, revealed: [true, false] };
    const first = { ...draw, id: await collisionReadingId(draw) };
    const assigned = { ...draw, id: first.id + '-1' };
    const key = saveRecoveryCopy('tester', source);
    await importTargetRecorder(loadRecoveryCopies('tester').copies, source)(assigned.id);
    trustedCache([first, assigned]);
    const { result } = renderHook(() => useAccountJournal('tester', first.id));
    await act(async () => result.current.remove(first.id));
    expect(localStorage.getItem(key)).not.toBeNull();
    expect(result.current.savedRecovery.readings).toEqual([
      { ...source, id: assigned.id, sourceId: source.id },
    ]);
  });

  it('preserves the original reading’s unsynced reveal when the owner deletes its alternate', async () => {
    const pending = { ...draw, revealed: [true, false] };
    const alternate = { ...draw, id: await collisionReadingId(draw) };
    const pendingKey = saveRecoveryCopy('tester', pending);
    trustedCache([draw, alternate]);
    const { result, unmount } = renderHook(() => useAccountJournal('tester', alternate.id));
    await act(async () => result.current.remove(alternate.id));
    expect(removeReading).toHaveBeenCalledWith('tester', alternate);
    expect(localStorage.getItem(pendingKey)).toBe(JSON.stringify(pending));
    unmount();
    trustedCache([draw]);
    const reopened = renderHook(() => useAccountJournal('tester', draw.id));
    expect(reopened.result.current.savedRecovery.readings).toEqual([pending]);
  });

  it('recovers a verified local-only deletion marker at one assigned destination and cleans up both copies', async () => {
    const owner = 'prepared-retained-retry';
    const key = saveRecoveryCopy(owner, draw);
    prepareRecoveryDeletion([{ key, reading: draw, targetId: null }]);
    const replacement = { ...draw, question: 'The different reading at the original ID' };
    vi.mocked(observeReadings).mockImplementation((_uid, _limit, publish) => {
      publish([replacement], { fromCache: false, pending: false, hasMore: false });
      return () => {};
    });
    const current = renderHook(() => useAccountJournal(owner, null));
    await waitFor(() => expect(current.result.current.savedRecovery.readings).toEqual([draw]));
    const stalePreview = current.result.current.savedRecovery;
    let retained!: ReturnType<typeof current.result.current.savedRecovery.retainUntilChecked>;
    act(() => {
      retained = current.result.current.savedRecovery.retainUntilChecked();
    });
    const assigned = { ...draw, id: await collisionReadingId(draw), sourceId: draw.id };
    await importTargetRecorder(retained.copies, draw)(assigned.id);
    expect(stalePreview.isCurrent()).toBe(false);
    act(() => window.dispatchEvent(new Event('focus')));
    expect(current.result.current.savedRecovery.readings).toEqual([assigned]);
    act(() => {
      expect(current.result.current.getRecoveryForExport().readings).toEqual([assigned]);
      const retried = current.result.current.savedRecovery.retainUntilChecked();
      expect(retried.copies).toEqual(retained.copies);
    });
    current.unmount();
    const reopened = renderHook(() => useAccountJournal(owner, null));
    await waitFor(() => expect(reopened.result.current.recoveryComplete).toBe(true));
    expect(reopened.result.current.savedRecovery.readings).toEqual([assigned]);
    act(() => reopened.result.current.savedRecovery.discard());
    expect(loadRecoveryCopies(owner)).toEqual({
      copies: [],
      prepared: [],
      pendingCleanup: [],
      complete: true,
    });
    reopened.unmount();
    const later = renderHook(() => useAccountJournal(owner, null));
    expect(later.result.current.savedRecovery.readings).toEqual([]);
  });

  it.each([false, true])(
    'reconciles a deleted retained reading after reopening (another recovery was confirmed: %s)',
    async (recoverAgain) => {
      const owner = 'interrupted-retained-delete';
      const reveal = { ...draw, revealed: [true, false] };
      const key = saveRecoveryCopy(owner, reveal);
      prepareRecoveryDeletion([{ key, reading: reveal, targetId: null }]);
      const synced = { fromCache: false, pending: false, hasMore: false };
      trustedCache([draw]);
      const first = renderHook(() => useAccountJournal(owner, null));
      const publish = vi.mocked(observeReadings).mock.lastCall![2];
      await act(async () => publish([draw], synced));
      expect(first.result.current.savedRecovery.readings).toEqual([reveal]);
      act(() => first.result.current.savedRecovery.retainUntilChecked());

      vi.mocked(removeReading).mockReturnValueOnce(pendingWrite().promise);
      act(() => {
        void first.result.current.remove(draw.id);
      });
      expect(removeReading).toHaveBeenCalledExactlyOnceWith(owner, draw);
      first.unmount();

      trustedCache([]);
      const reopened = renderHook(() => useAccountJournal(owner, null));
      const publishAfterRestart = vi.mocked(observeReadings).mock.lastCall![2];
      expect(reopened.result.current.recoveryComplete).toBe(false);
      if (recoverAgain) {
        // The original deletion is still pending. A new unchecked recovery
        // preserves the reveal that the server has not acknowledged.
        vi.mocked(readDeletionTarget).mockResolvedValueOnce(draw);
        await act(async () => publishAfterRestart([draw], synced));
        expect(reopened.result.current.savedRecovery.readings).toEqual([reveal]);
        act(() => reopened.result.current.savedRecovery.retainUntilChecked());
      }
      vi.mocked(readDeletionTarget).mockResolvedValueOnce(undefined);
      await act(async () => publishAfterRestart([], synced));
      const expected = recoverAgain ? [reveal] : [];
      expect(reopened.result.current.recoveryComplete).toBe(true);
      expect(reopened.result.current.savedRecovery.readings).toEqual(expected);
      act(() => expect(reopened.result.current.getRecoveryForExport().readings).toEqual(expected));
      expect(loadRecoveryCopies(owner).prepared).toEqual([]);
    },
  );

  it('keeps a discard marker across reload if the superseded source cannot be changed', async () => {
    trustedCache([]);
    const owner = 'retained-discard';
    const key = saveRecoveryCopy(owner, draw);
    const current = renderHook(() => useAccountJournal(owner, null));
    act(() => current.result.current.savedRecovery.retainUntilChecked());
    const setItem = Storage.prototype.setItem;
    const removeItem = Storage.prototype.removeItem;
    const blockWrite = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      target,
      value,
    ) {
      if (target === key) throw new Error('Source locked');
      return setItem.call(this, target, value);
    });
    const blockRemove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (
      this: Storage,
      target,
    ) {
      if (target === key) throw new Error('Source locked');
      return removeItem.call(this, target);
    });
    try {
      act(() => current.result.current.savedRecovery.discard());
      current.unmount();
      const reopened = renderHook(() => useAccountJournal(owner, null));
      expect(reopened.result.current.savedRecovery.readings).toEqual([]);
      expect(reopened.result.current.syncError).toContain('waiting for removal');
      blockWrite.mockRestore();
      blockRemove.mockRestore();
      act(() => reopened.result.current.retrySync());
      expect(loadRecoveryCopies(owner)).toEqual({
        copies: [],
        prepared: [],
        pendingCleanup: [],
        complete: true,
      });
    } finally {
      blockWrite.mockRestore();
      blockRemove.mockRestore();
    }
  });

  it.each(['delete', 'clear', 'discard'] as const)(
    'reports a failed local removal after %s and retries only the confirmed keys',
    async (action) => {
      const retained = saveRecoveryCopy('tester', draw);
      const other = { ...draw, id: 'another-reading' };
      const otherKey = saveRecoveryCopy('tester', other);
      trustedCache([draw]);
      const removeItem = Storage.prototype.removeItem;
      const readOnly = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (
        this: Storage,
        key: string,
      ) {
        if (key === retained) throw new DOMException('Storage is read-only', 'SecurityError');
        removeItem.call(this, key);
      });
      try {
        const { result, unmount } = renderHook(() => useAccountJournal('tester', draw.id));
        const preview = result.current.savedRecovery;
        expect(preview.isCurrent()).toBe(true);
        if (action === 'discard') act(() => result.current.savedRecovery.discard());
        else await act(async () => result.current.remove(action === 'clear' ? undefined : draw.id));
        expect(localStorage.getItem(retained)).not.toBeNull();
        expect(preview.isCurrent()).toBe(false);
        expect(result.current.syncError).toContain('1 recovery copy waiting for removal');
        expect(result.current.syncError).toContain(draw.question);
        expect(result.current.savedRecovery.readings).not.toContainEqual(draw);
        expect(result.current.recoveryReadings).not.toContainEqual(draw);
        expect(localStorage.getItem(otherKey) !== null).toBe(action === 'delete');

        unmount();
        const reopened = renderHook(() => useAccountJournal('tester', null));
        expect(reopened.result.current.syncError).toContain('1 recovery copy waiting for removal');
        expect(reopened.result.current.savedRecovery.readings).not.toContainEqual(draw);
        expect(reopened.result.current.recoveryReadings).not.toContainEqual(draw);
        const newer = { ...draw, question: 'Another tab saved this after confirmation' };
        const newerKey = saveRecoveryCopy('tester', newer);
        readOnly.mockRestore();
        act(() => reopened.result.current.retrySync());
        expect(removeReading).toHaveBeenCalledTimes(action === 'delete' ? 1 : 0);
        expect(clearReadings).toHaveBeenCalledTimes(action === 'clear' ? 1 : 0);
        expect(localStorage.getItem(retained)).toBeNull();
        expect(localStorage.getItem(newerKey)).toEqual(JSON.stringify(newer));
        expect(reopened.result.current.syncError).toBe('');
      } finally {
        readOnly.mockRestore();
      }
    },
  );

  it.each(['delete', 'clear'] as const)(
    'defers %s while the recovery store is fully read-only',
    async (action) => {
      const before = saveRecoveryCopy('tester', draw);
      trustedCache([draw]);
      const denied = () => {
        throw new DOMException('Storage is read-only', 'SecurityError');
      };
      const blockSet = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(denied);
      const blockRemove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(denied);
      try {
        const { result, unmount } = renderHook(() => useAccountJournal('tester', draw.id));
        await act(async () => {
          await expect(
            result.current.remove(action === 'delete' ? draw.id : undefined),
          ).rejects.toThrow(/deletion could not start/i);
        });
        expect(clearReadings).not.toHaveBeenCalled();
        expect(removeReading).not.toHaveBeenCalled();
        expect(localStorage.getItem(before)).toBe(JSON.stringify(draw));
        expect(result.current.deleteError).toMatch(/confirm again/i);
        unmount();
        blockSet.mockRestore();
        blockRemove.mockRestore();
        const reopened = renderHook(() => useAccountJournal('tester', draw.id));
        expect(reopened.result.current.active).toEqual(draw);
        await act(async () =>
          reopened.result.current.remove(action === 'delete' ? draw.id : undefined),
        );
        expect(localStorage.getItem(before)).toBeNull();
        expect(clearReadings).toHaveBeenCalledTimes(action === 'clear' ? 1 : 0);
        expect(removeReading).toHaveBeenCalledTimes(action === 'delete' ? 1 : 0);
      } finally {
        blockSet.mockRestore();
        blockRemove.mockRestore();
      }
    },
  );

  it('withdraws a confirmed deletion before acknowledgement and restores its copy after rejection', async () => {
    trustedCache([draw]);
    const expected = { ...draw, revealed: [true, false] };
    vi.mocked(revealCards).mockRejectedValueOnce(new Error('Reveal failed'));
    const original = renderHook(() => useAccountJournal('tester', draw.id));
    await act(async () => original.result.current.reveal(draw.id, [0]));
    expect(original.result.current.recoveryReadings).toEqual([expected]);
    original.unmount();

    const acknowledgement = pendingWrite();
    vi.mocked(removeReading).mockReturnValueOnce(acknowledgement.promise);
    const deleting = renderHook(() => useAccountJournal('tester', draw.id));
    expect(deleting.result.current.savedRecovery.readings).toEqual([expected]);
    let deletion!: Promise<void>;
    act(() => {
      deletion = deleting.result.current.remove(draw.id);
    });
    expect(removeReading).toHaveBeenCalledWith('tester', draw);
    expect(deleting.result.current.savedRecovery.readings).toEqual([]);
    const reopened = renderHook(() => useAccountJournal('tester', draw.id));
    expect(reopened.result.current.savedRecovery.readings).toEqual([]);
    reopened.unmount();

    await act(async () => {
      acknowledgement.reject(new Error('Delete failed'));
      await expect(deletion).rejects.toThrow('Delete failed');
    });
    expect(deleting.result.current.deleteError).toContain('confirm again');
    expect(deleting.result.current.savedRecovery.readings).toEqual([expected]);
  });

  it('keeps shared-device recovery in tab memory when a deletion is rejected', async () => {
    const owner = 'session-only-deletion';
    saveTabRecoveryCopy(owner, draw);
    trustedCache([draw]);
    vi.mocked(isOfflineJournalEnabled).mockReturnValue(false);
    vi.mocked(removeReading).mockRejectedValueOnce(new Error('Delete failed'));
    const { result } = renderHook(() => useAccountJournal(owner, draw.id));
    await act(async () => {
      await expect(result.current.remove(draw.id)).rejects.toThrow('Delete failed');
    });
    expect(result.current.savedRecovery.readings).toEqual([draw]);
    expect(localStorage.length).toBe(0);
    act(() => result.current.savedRecovery.discard());
  });

  it.each([true, false])(
    'reconciles a staged deletion only after a server snapshot (reading still exists: %s)',
    async (exists) => {
      const updated = { ...draw, revealed: [true, false] };
      const key = saveRecoveryCopy('tester', updated);
      trustedCache([draw]);
      vi.mocked(removeReading).mockReturnValueOnce(pendingWrite().promise);
      const first = renderHook(() => useAccountJournal('tester', draw.id));
      act(() => {
        void first.result.current.remove(draw.id);
      });
      first.unmount();
      const reopened = renderHook(() => useAccountJournal('tester', null));
      act(() => reopened.result.current.retrySync());
      expect(localStorage.getItem(key)).not.toBeNull();
      expect(reopened.result.current.savedRecovery.readings).toEqual([]);
      expect(reopened.result.current.recoveryComplete).toBe(false);
      vi.mocked(observeReadings).mockImplementation((_uid, _limit, onChange) => {
        // A locally removed document may already be absent, including from a
        // current query that reports no pending writes for its remaining rows.
        onChange([], { fromCache: false, pending: false, hasMore: false });
        return () => {};
      });
      let finishServerCheck!: (value: Reading | undefined) => void;
      vi.mocked(readDeletionTarget).mockReturnValueOnce(
        new Promise((resolve) => {
          finishServerCheck = resolve;
        }),
      );
      await act(async () => reopened.result.current.retrySync());
      expect(readDeletionTarget).toHaveBeenCalledWith('tester', draw.id);
      expect(localStorage.getItem(key)).not.toBeNull();
      expect(reopened.result.current.recoveryComplete).toBe(false);
      await act(async () => finishServerCheck(exists ? draw : undefined));
      expect(reopened.result.current.savedRecovery.readings).toEqual(exists ? [updated] : []);
      expect(reopened.result.current.recoveryComplete).toBe(true);
      if (exists) {
        expect(reopened.result.current.savedRecovery.isCurrent()).toBe(true);
        // A sibling can see the surviving spread before the first tab's delete
        // commits. On the next mount, only the new server state is authoritative.
        reopened.unmount();
        trustedCache([draw]);
        const later = renderHook(() => useAccountJournal('tester', null));
        expect(later.result.current.savedRecovery.readings).toEqual([]);
        expect(later.result.current.recoveryComplete).toBe(false);
        const publish = vi.mocked(observeReadings).mock.lastCall![2];
        await act(async () => publish([], { fromCache: false, pending: false, hasMore: false }));
        expect(later.result.current.recoveryComplete).toBe(true);
        expect(later.result.current.savedRecovery.readings).toEqual([]);
      }
      expect(localStorage.getItem(key)).toBeNull();
      expect(removeReading).toHaveBeenCalledTimes(1);
    },
  );
});
