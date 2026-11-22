import { draw, trustedCache } from '../helpers/unsyncedJournal';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  lookupRecoveryReading,
  observeReadings,
  removeReading,
} from '@/services/Journal/journal.service';
import {
  loadRecoveryCopies,
  prepareRecoveryDeletion,
  importTargetRecorder,
  retainRecoveryCopies,
  resolvedRecoveryCopies,
  saveRecoveryCopy,
} from '@/features/Journal/features/AccountJournal/utils/readingRecovery';
import { saveTabRecoveryCopy } from '@/features/Journal/features/AccountJournal/utils/tabRecovery';
import {
  collisionReadingId,
  mergeJournalReadings,
  resolveImportReading,
} from '@/features/Journal/utils/journalBackup';
import { useAccountJournal } from '@/features/Journal/features/AccountJournal/hooks/useAccountJournal';

describe('restoring and exporting unsynced readings', () => {
  it.each([false, true])(
    'retires an interrupted recovery import under its resolved ID (paginated: %s)',
    async (paginated) => {
      const primary = { ...draw, question: 'A different spread with the old ID' };
      const firstAlternate = { ...primary, id: await collisionReadingId(draw) };
      const byId = new Map([primary, firstAlternate].map((entry) => [entry.id, entry]));
      const { id } = await resolveImportReading(draw, (candidate) => byId.get(candidate));
      const imported = { ...draw, id };
      const synced = saveRecoveryCopy('tester', draw);
      const furtherReveal = { ...draw, revealed: [true, false] };
      const unsynced = saveRecoveryCopy('tester', furtherReveal);
      const other = { ...draw, id: 'independent-copy-of-same-content' };
      const unrelated = saveRecoveryCopy('tester', other);
      vi.mocked(lookupRecoveryReading).mockImplementation(async (_uid, key) => byId.get(key));
      vi.mocked(observeReadings).mockImplementation((_uid, _limit, onChange) => {
        onChange(paginated ? [imported] : [primary, firstAlternate, imported], {
          fromCache: false,
          pending: false,
          hasMore: paginated,
        });
        return () => {};
      });
      const { result, unmount } = renderHook(() => useAccountJournal('tester', id));
      await waitFor(() => expect(localStorage.getItem(synced)).toBeNull());
      if (paginated)
        expect(lookupRecoveryReading).toHaveBeenCalledWith('tester', firstAlternate.id);
      else expect(lookupRecoveryReading).not.toHaveBeenCalled();
      expect(result.current.savedRecovery.readings).toContainEqual(furtherReveal);
      await act(async () => result.current.remove(id));
      expect(removeReading).toHaveBeenCalledWith('tester', imported);
      expect(localStorage.getItem(unsynced)).toBeNull();
      expect(localStorage.getItem(unrelated)).toEqual(JSON.stringify(other));
      unmount();
      const reopened = renderHook(() => useAccountJournal('tester', null));
      expect(reopened.result.current.savedRecovery.readings).toEqual([other]);
    },
  );

  it('remembers the assigned document across reload and rollback even after all earlier collision slots disappear', async () => {
    const owner = 'mapped-source';
    const id = await collisionReadingId(draw, 76);
    const imported = { ...draw, id };
    const key = saveRecoveryCopy(owner, draw);
    await importTargetRecorder(loadRecoveryCopies(owner).copies, draw)(id);
    const reopened = loadRecoveryCopies(owner).copies;
    expect(reopened).toEqual([{ key, reading: draw, importedAs: id }]);
    expect(await resolvedRecoveryCopies(reopened, [imported], [imported], false)).toEqual(reopened);
    const rollback = prepareRecoveryDeletion(reopened.map((copy) => ({ ...copy, targetId: id })));
    rollback();
    expect(loadRecoveryCopies(owner).copies).toEqual(reopened);
    expect(loadRecoveryCopies('another-account').copies).toEqual([]);
  });

  it('recovers and backs up both readings when they have different unsynced reveals', async () => {
    const original = { ...draw, revealed: [true, false] };
    const imported = { ...draw, revealed: [false, true] };
    const alternate = { ...draw, id: await collisionReadingId(draw) };
    saveRecoveryCopy('tester', imported);
    await importTargetRecorder(loadRecoveryCopies('tester').copies, imported)(alternate.id);
    saveRecoveryCopy('tester', original);
    trustedCache([draw, alternate]);
    const { result } = renderHook(() => useAccountJournal('tester', draw.id));
    const expected = [original, { ...imported, id: alternate.id, sourceId: imported.id }];
    act(() => {
      for (const readings of [
        result.current.savedRecovery.readings,
        result.current.getRecoveryForExport().readings,
      ]) {
        expect(readings).toHaveLength(2);
        expect(readings).toEqual(expect.arrayContaining(expected));
      }
    });
  });

  it.each([false, true])(
    'preserves the assigned reveal in a full backup when its destination is absent or replaced (replaced: %s)',
    async (replaced) => {
      const pending = { ...draw, revealed: [true, false] };
      const assigned = { ...pending, id: await collisionReadingId(draw), sourceId: draw.id };
      const occupant = { ...draw, id: assigned.id, question: 'A new reading at that ID' };
      const independent = { ...draw, id: await collisionReadingId(draw, 100) };
      const cloud = replaced ? [draw, occupant, independent] : [draw, independent];
      saveRecoveryCopy('tester', pending);
      await importTargetRecorder(loadRecoveryCopies('tester').copies, pending)(assigned.id);
      trustedCache(cloud);
      const { result } = renderHook(() => useAccountJournal('tester', null));
      const recovery = result.current.savedRecovery;
      expect(recovery.readings).toEqual([assigned]);
      let exported!: ReturnType<typeof result.current.getRecoveryForExport>;
      act(() => {
        exported = result.current.getRecoveryForExport();
      });
      const { readings } = await mergeJournalReadings(
        cloud,
        exported.readings,
        exported.assignedIds,
      );
      const targetId = replaced ? assigned.id + '-1' : assigned.id;
      expect(readings).toHaveLength(cloud.length + 1);
      const portable = { ...assigned, id: targetId };
      expect(readings).toEqual(expect.arrayContaining([...cloud, portable]));
      if (replaced) {
        await importTargetRecorder(loadRecoveryCopies('tester').copies, assigned)(targetId);
        expect(recovery.isCurrent()).toBe(false);
        act(() => window.dispatchEvent(new Event('focus')));
        expect(result.current.savedRecovery.readings).toEqual([{ ...assigned, id: targetId }]);
      }
    },
  );

  it.each([false, true])(
    'retains the same recovery copies across tabs and reloads (assigned: %s)',
    async (assigned) => {
      trustedCache([]);
      const key = saveRecoveryCopy('tester', draw);
      const target = assigned
        ? { ...draw, id: await collisionReadingId(draw), sourceId: draw.id }
        : draw;
      if (assigned)
        await importTargetRecorder(loadRecoveryCopies('tester').copies, draw)(target.id);
      const first = renderHook(() => useAccountJournal('tester', null));
      const sibling = renderHook(() => useAccountJournal('tester', null));
      const firstPreview = first.result.current.savedRecovery;
      const siblingPreview = sibling.result.current.savedRecovery;
      act(() => {
        firstPreview.retainUntilChecked();
        siblingPreview.retainUntilChecked();
        firstPreview.retainUntilChecked();
      });
      expect(loadRecoveryCopies('tester').copies).toHaveLength(2);
      first.unmount();
      sibling.unmount();
      // A late acknowledgement may discard the original key in any tab.
      const reopened = renderHook(() => useAccountJournal('tester', null));
      const publish = vi.mocked(observeReadings).mock.lastCall![2];
      await act(async () =>
        publish([target], { fromCache: false, pending: false, hasMore: false }),
      );
      expect(localStorage.getItem(key)).toBeNull();
      expect(reopened.result.current.savedRecovery.readings).toEqual([target]);
      const [retained] = loadRecoveryCopies('tester').copies;
      expect(retained.reading).toEqual(draw);
      expect(retained.importedAs).toBe(assigned ? target.id : undefined);
      act(() => reopened.result.current.savedRecovery.retainUntilChecked());
      expect(loadRecoveryCopies('tester').copies).toHaveLength(1);
      await act(async () => publish([], { fromCache: false, pending: false, hasMore: false }));
      expect(reopened.result.current.savedRecovery.readings).toEqual([target]);
      act(() => reopened.result.current.savedRecovery.discard());
      expect(loadRecoveryCopies('tester').copies).toEqual([]);
    },
  );

  it('keeps the source copy when storage refuses to retain it for an unchecked import', () => {
    const key = saveRecoveryCopy('tester', draw);
    const original = loadRecoveryCopies('tester').copies;
    const full = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    try {
      expect(() => retainRecoveryCopies('tester', original)).toThrow(
        /Download your unsynced readings/,
      );
      expect(loadRecoveryCopies('tester').copies).toEqual([{ key, reading: draw }]);
    } finally {
      full.mockRestore();
    }
  });

  it('keeps a tab-only unchecked recovery with its account until explicit discard', async () => {
    const owner = 'restricted-recovery';
    const key = saveTabRecoveryCopy(owner, draw);
    const target = { ...draw, id: await collisionReadingId(draw), sourceId: draw.id };
    await importTargetRecorder(loadRecoveryCopies(owner).copies, draw)(target.id);
    const current = renderHook(() => useAccountJournal(owner, null));
    act(() => current.result.current.savedRecovery.retainUntilChecked());
    act(() => current.result.current.savedRecovery.retainUntilChecked());
    expect(current.result.current.needsOpenTab).toBe(true);
    expect(localStorage.length).toBe(0);
    const publish = vi.mocked(observeReadings).mock.lastCall![2];
    await act(async () => publish([target], { fromCache: false, pending: false, hasMore: false }));
    expect(loadRecoveryCopies(owner).copies.map((copy) => copy.key)).not.toContain(key);
    expect(current.result.current.savedRecovery.readings).toEqual([target]);
    current.unmount();
    const other = renderHook(() => useAccountJournal('other-account', null));
    expect(other.result.current.savedRecovery.readings).toEqual([]);
    other.unmount();
    const returned = renderHook(() => useAccountJournal(owner, null));
    expect(returned.result.current.savedRecovery.readings).toEqual([target]);
    act(() => returned.result.current.savedRecovery.discard());
    expect(returned.result.current.needsOpenTab).toBe(false);
    expect(loadRecoveryCopies(owner).copies).toEqual([]);
  });

  it('can import a fingerprinted reading when its local receipt cannot be written', async () => {
    const owner = 'quota-during-import';
    saveRecoveryCopy(owner, draw);
    const id = (await collisionReadingId(draw)) + '-3';
    const copies = loadRecoveryCopies(owner).copies;
    const full = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    try {
      await expect(importTargetRecorder(copies, draw)(id)).resolves.toBeUndefined();
      expect(
        await resolvedRecoveryCopies(copies, [{ ...draw, id }], [{ ...draw, id }], true),
      ).toEqual(copies);
    } finally {
      full.mockRestore();
    }
  });
});
