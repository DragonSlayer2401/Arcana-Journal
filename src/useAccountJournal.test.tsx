import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as journalActivity from './cloud/journalActivity';
import {
  clearReadings,
  createReading,
  isOfflineJournalEnabled,
  lookupRecoveryImportTarget,
  lookupRecoveryReading,
  observeReadings,
  readDeletionTarget,
  removeReading,
  revealCards,
} from './cloud/journal';
import { JournalTransfer } from './components/JournalTransfer';
import {
  loadRecoveryCopies,
  prepareRecoveryDeletion,
  importTargetRecorder,
  retainRecoveryCopies,
  resolvedRecoveryCopies,
  saveRecoveryCopy,
} from './domain/readingRecovery';
import { saveTabRecoveryCopy } from './domain/tabRecovery';
import {
  collisionReadingId,
  mergeJournalReadings,
  resolveImportReading,
} from './domain/journalBackup';
import type { Reading } from './domain/types';
import { useAccountJournal } from './useAccountJournal';

vi.mock('./cloud/journal', () => ({
  clearReadings: vi.fn(),
  withClearPreparation: (
    uid: string,
    prepare: Parameters<typeof import('./cloud/journal').withClearPreparation>[1],
  ) => prepare((submitted) => clearReadings(uid, submitted)),
  createReading: vi.fn(),
  isOfflineJournalEnabled: vi.fn(),
  lookupRecoveryReading: vi.fn(),
  lookupRecoveryImportTarget: vi.fn(),
  observePendingDeletions: () => () => {},
  readDeletionTarget: vi.fn(),
  observeReading: () => () => {},
  observeReadings: vi.fn(),
  removeReading: vi.fn(),
  revealCards: vi.fn(),
}));

const draw: Reading = {
  id: 'new-spread',
  question: 'A question only this device has',
  createdAt: '2026-10-02T11:11:11Z',
  cards: [
    { cardId: 'major-01', orientation: 'reversed' },
    { cardId: 'major-02', orientation: 'upright' },
  ],
  revealed: [false, false],
};

const trustedCache = (readings: Reading[]) => {
  vi.mocked(isOfflineJournalEnabled).mockReturnValue(true);
  vi.mocked(observeReadings).mockImplementation((_uid, _limit, onChange) => {
    onChange(readings, { fromCache: true, pending: false, hasMore: false });
    return () => {};
  });
};

const pendingWrite = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, deny) => {
    resolve = accept;
    reject = deny;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  vi.mocked(isOfflineJournalEnabled).mockReturnValue(false);
  vi.mocked(observeReadings).mockReturnValue(() => {});
});

describe('recovering rejected journal writes', () => {
  it('downloads a rejected draw offline with its latest reveals and can discard it before signing out', async () => {
    const user = userEvent.setup();
    vi.mocked(createReading).mockRejectedValueOnce(new Error('Write denied'));
    const onExport = vi.fn();
    const file = vi.fn<(_blob: Blob) => string>().mockReturnValue('blob:recovery');
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = file;
        static revokeObjectURL = vi.fn();
      },
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const Recovery = () => {
      const journal = useAccountJournal('tester', draw.id);
      return (
        <>
          <button onClick={() => journal.saveDraw(draw)}>Draw</button>
          <button onClick={() => journal.reveal(draw.id, [1])}>Reveal second</button>
          <button onClick={() => void journal.remove(draw.id)}>Confirm discard</button>
          <button disabled={journal.pending}>Sign out</button>
          <p>{journal.syncError}</p>
          <JournalTransfer
            accountEmail="test@example.org"
            deviceCount={0}
            getDeviceReadings={() => []}
            recoveryReadings={journal.recoveryReadings}
            onExport={onExport}
            onPreview={vi.fn()}
            onImport={vi.fn()}
          />
        </>
      );
    };
    try {
      render(<Recovery />);
      await user.click(screen.getByRole('button', { name: 'Draw' }));
      expect(await screen.findByText('Write denied')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Sign out' })).toBeDisabled();
      await user.click(screen.getByRole('button', { name: 'Reveal second' }));
      expect(revealCards).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'Download unsynced readings' }));
      expect(await screen.findByRole('link', { name: 'Download backup' })).toHaveAttribute(
        'download',
        expect.stringContaining('unsynced'),
      );
      const json = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.readAsText(file.mock.calls[0][0]);
      });
      expect(JSON.parse(json)).toEqual({
        version: 1,
        readings: [{ ...draw, createdAt: '2026-10-02T11:11:11.000Z', revealed: [false, true] }],
      });
      expect(onExport).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'Confirm discard' }));
      expect(removeReading).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled();
      expect(
        screen.queryByRole('button', { name: 'Download unsynced readings' }),
      ).not.toBeInTheDocument();
    } finally {
      click.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('retries a failed draw with the original spread and all local reveal progress', async () => {
    vi.mocked(createReading)
      .mockRejectedValueOnce(new Error('Unavailable'))
      .mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useAccountJournal('tester', draw.id));
    await act(async () => result.current.saveDraw(draw));
    act(() => {
      result.current.reveal(draw.id, [0]);
      result.current.reveal(draw.id, [1]);
    });
    expect(result.current.active?.revealed).toEqual([true, true]);
    await act(async () => result.current.retrySync());
    expect(createReading).toHaveBeenLastCalledWith('tester', { ...draw, revealed: [true, true] });
    expect(result.current.recoveryReadings).toEqual([]);
    expect(result.current.pending).toBe(false);
  });

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
});

describe('recovery copies on a trusted browser', () => {
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
