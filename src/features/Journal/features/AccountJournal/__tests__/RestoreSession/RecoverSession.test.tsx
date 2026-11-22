import { draw, pendingWrite, trustedCache } from '../helpers/unsyncedJournal';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as journalActivity from '@/services/Journal/journalActivity';
import { createReading, removeReading } from '@/services/Journal/journal.service';
import { useAccountJournal } from '@/features/Journal/features/AccountJournal/hooks/useAccountJournal';

describe('protecting unsynced readings across sessions', () => {
  it('protects a rejected draw from sibling sign-out until the owner discards it', async () => {
    trustedCache([]);
    const release = vi.fn();
    const guard = vi.spyOn(journalActivity, 'holdJournalEdits').mockReturnValue(release);
    try {
      const acknowledgement = pendingWrite();
      vi.mocked(createReading).mockReturnValueOnce(acknowledgement.promise);
      const { result } = renderHook(() => useAccountJournal('tester', draw.id));
      act(() => {
        result.current.saveDraw(draw);
        expect(guard).toHaveBeenCalledWith('tester');
      });
      await act(async () => acknowledgement.reject(new Error('Rejected')));
      expect(result.current.hasFailedWrites).toBe(true);
      expect(release).not.toHaveBeenCalled();
      await act(async () => result.current.remove(draw.id));
      expect(result.current.hasFailedWrites).toBe(false);
      expect(release).toHaveBeenCalledOnce();
    } finally {
      guard.mockRestore();
    }
  });

  it('warns a locked tab when its pending draw loses its recovery copy in another tab', async () => {
    trustedCache([]);
    const acknowledgement = pendingWrite();
    vi.mocked(createReading).mockReturnValueOnce(acknowledgement.promise);
    const writer = renderHook(({ locked }) => useAccountJournal('tester', draw.id, locked), {
      initialProps: { locked: false },
    });
    act(() => writer.result.current.saveDraw(draw));
    expect(writer.result.current.needsOpenTab).toBe(false);

    const sibling = renderHook(() => useAccountJournal('tester', null));
    expect(sibling.result.current.savedRecovery.readings).toEqual([draw]);
    const key = localStorage.key(0);
    expect(key).toBeTruthy();
    writer.rerender({ locked: true });
    expect(writer.result.current.needsOpenTab).toBe(false);
    act(() => sibling.result.current.savedRecovery.discard());
    // A browser delivers the other tab's removal to this window as a storage event.
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key, storageArea: localStorage }));
    });
    expect(writer.result.current.needsOpenTab).toBe(true);
    expect(writer.result.current.recoveryReadings).toEqual([draw]);
    await act(async () => acknowledgement.resolve());
    expect(writer.result.current.needsOpenTab).toBe(false);
  });

  it('keeps an unbacked draw in its original tab for its owner across account changes', async () => {
    trustedCache([]);
    const acknowledgement = pendingWrite();
    vi.mocked(createReading).mockReturnValueOnce(acknowledgement.promise);
    const writer = renderHook(() => useAccountJournal('tester', draw.id));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('Storage full', 'QuotaExceededError');
    });

    act(() => writer.result.current.saveDraw(draw));
    expect(writer.result.current.needsOpenTab).toBe(true);
    expect(writer.result.current.recoveryReadings).toEqual([draw]);
    writer.unmount();
    const other = renderHook(() => useAccountJournal('other-account', null));
    expect(other.result.current.savedRecovery.readings).toEqual([]);
    expect(other.result.current.recoveryReadings).toEqual([]);
    other.unmount();
    const reopened = renderHook(() => useAccountJournal('tester', draw.id));
    expect(reopened.result.current.savedRecovery.readings).toEqual([draw]);
    expect(reopened.result.current.needsOpenTab).toBe(true);
    await act(async () => acknowledgement.resolve());
    expect(reopened.result.current.savedRecovery.readings).toEqual([]);
    expect(reopened.result.current.needsOpenTab).toBe(false);
  });

  it('recovers an active draw if its durable copy disappeared before a sibling signed out', async () => {
    trustedCache([]);
    const acknowledgement = pendingWrite();
    vi.mocked(createReading).mockReturnValueOnce(acknowledgement.promise);
    const writer = renderHook(() => useAccountJournal('tester', draw.id));
    act(() => writer.result.current.saveDraw(draw));
    localStorage.removeItem(localStorage.key(0)!);
    writer.unmount();

    const reopened = renderHook(() => useAccountJournal('tester', draw.id));
    expect(reopened.result.current.savedRecovery.readings).toEqual([draw]);
    expect(reopened.result.current.needsOpenTab).toBe(true);
    await act(async () => acknowledgement.resolve());
    expect(reopened.result.current.savedRecovery.readings).toEqual([]);
  });

  it('honors a confirmed offline deletion when the owner signs out before acknowledgment', async () => {
    trustedCache([]);
    const create = pendingWrite();
    const deletion = pendingWrite();
    vi.mocked(createReading).mockReturnValueOnce(create.promise);
    vi.mocked(removeReading).mockReturnValueOnce(deletion.promise);
    const writer = renderHook(() => useAccountJournal('tester', draw.id));
    act(() => writer.result.current.saveDraw(draw));
    act(() => {
      void writer.result.current.remove(draw.id);
    });
    writer.unmount();
    const reopened = renderHook(() => useAccountJournal('tester', draw.id));
    expect(reopened.result.current.savedRecovery.readings).toEqual([]);
    await act(async () => {
      create.resolve();
      deletion.resolve();
    });
    expect(reopened.result.current.savedRecovery.readings).toEqual([]);
  });
});
