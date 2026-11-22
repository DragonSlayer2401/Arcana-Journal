import { draw } from '../helpers/unsyncedJournal';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  clearReadings,
  lookupRecoveryImportTarget,
  observeReadings,
  readDeletionTarget,
} from '@/services/Journal/journal.service';
import {
  loadRecoveryCopies,
  importTargetRecorder,
  saveRecoveryCopy,
} from '@/features/Journal/features/AccountJournal/utils/readingRecovery';
import { collisionReadingId } from '@/features/Journal/utils/journalBackup';
import type { Reading } from '@/features/Journal/readingTypes';
import { useAccountJournal } from '@/features/Journal/features/AccountJournal/hooks/useAccountJournal';

describe('clearing account history with recoverable readings', () => {
  it('keeps a cleared historical alternate out of recovery after a later page fails', async () => {
    const old = { ...draw, id: await collisionReadingId(draw, 2) };
    const copy = { ...draw, revealed: [true, false] };
    const key = saveRecoveryCopy('tester', copy);
    vi.mocked(observeReadings).mockImplementation((_uid, _limit, onChange) => {
      onChange([], { fromCache: false, pending: false, hasMore: true });
      return () => {};
    });
    vi.mocked(lookupRecoveryImportTarget).mockResolvedValue(old.id);
    vi.mocked(clearReadings).mockImplementation(async (_uid, onPageDeleted) => {
      expect(loadRecoveryCopies('tester').prepared[0].targetId).toBe(old.id);
      onPageDeleted?.();
      throw new Error('Second page failed');
    });
    vi.mocked(readDeletionTarget).mockResolvedValue(undefined);
    const { result } = renderHook(() => useAccountJournal('tester', null));
    await act(async () => {
      await expect(result.current.remove()).rejects.toThrow('Second page failed');
    });
    await waitFor(() => expect(localStorage.getItem(key)).toBeNull());
    expect(lookupRecoveryImportTarget).toHaveBeenCalledWith('tester', copy);
    expect(result.current.savedRecovery.readings).toEqual([]);
  });

  it('keeps a displaced assigned copy when clearing stops after deleting its original ID', async () => {
    const reveal = { ...draw, revealed: [true, false] };
    const assignedId = await collisionReadingId(draw);
    const key = saveRecoveryCopy('tester', reveal);
    await importTargetRecorder(loadRecoveryCopies('tester').copies, reveal)(assignedId);
    const replacement = { ...draw, id: assignedId, question: 'Replacement at assigned ID' };
    let server = [draw, replacement];
    vi.mocked(observeReadings).mockImplementation((_uid, _limit, publish) => {
      publish(server, { fromCache: false, pending: false, hasMore: false });
      return () => {};
    });
    vi.mocked(readDeletionTarget).mockImplementation(async (_uid, id) =>
      server.find((reading) => reading.id === id),
    );
    vi.mocked(clearReadings).mockImplementation(async (_uid, onPageSubmitted) => {
      server = [replacement];
      onPageSubmitted?.();
      throw new Error('Could not clear the next page');
    });
    const { result } = renderHook(() => useAccountJournal('tester', null));
    await act(async () => {
      await expect(result.current.remove()).rejects.toThrow('Could not clear the next page');
    });
    await waitFor(() => expect(result.current.recoveryComplete).toBe(true));
    expect(loadRecoveryCopies('tester').prepared).toEqual([
      { key, reading: reveal, importedAs: assignedId, targetId: null },
    ]);
    expect(result.current.recoveryReadings).toEqual([
      { ...reveal, id: assignedId, sourceId: reveal.id },
    ]);
  });

  it('restores only surviving spreads and local-only copies after a later clear page fails', async () => {
    const first = { ...draw, id: 'cleared' };
    const survivor = { ...draw, id: 'survivor' };
    const local = { ...draw, id: 'local-only' };
    const progressed = (reading: Reading) => ({ ...reading, revealed: [true, false] });
    [first, survivor, local].forEach((reading) => saveRecoveryCopy('tester', progressed(reading)));
    let server = [first, survivor];
    vi.mocked(readDeletionTarget).mockImplementation(async (_uid, id) =>
      server.find((reading) => reading.id === id),
    );
    vi.mocked(observeReadings).mockImplementation((_uid, _limit, onChange) => {
      onChange(server, { fromCache: false, pending: false, hasMore: false });
      return () => {};
    });
    vi.mocked(clearReadings).mockImplementation(async (_uid, onPageDeleted) => {
      server = [survivor];
      onPageDeleted?.();
      throw new Error('Next page unavailable');
    });
    const { result } = renderHook(() => useAccountJournal('tester', null));
    await act(async () => {
      await expect(result.current.remove()).rejects.toThrow('Next page unavailable');
    });
    await waitFor(() => expect(result.current.recoveryComplete).toBe(true));
    expect(result.current.savedRecovery.readings).toHaveLength(2);
    expect(result.current.savedRecovery.readings).toContainEqual(progressed(survivor));
    expect(result.current.savedRecovery.readings).toContainEqual(progressed(local));
    expect(clearReadings).toHaveBeenCalledTimes(1);
  });
});
