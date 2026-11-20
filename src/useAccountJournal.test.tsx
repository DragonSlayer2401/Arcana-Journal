import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createReading, removeReading, revealCards } from './cloud/journal';
import { JournalTransfer } from './components/JournalTransfer';
import type { Reading } from './domain/types';
import { useAccountJournal } from './useAccountJournal';

vi.mock('./cloud/journal', () => ({
  clearReadings: vi.fn(),
  createReading: vi.fn(),
  isOfflineJournalEnabled: () => false,
  observeReading: () => () => {},
  observeReadings: () => () => {},
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

beforeEach(() => vi.clearAllMocks());

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
        readings: [{ ...draw, revealed: [false, true] }],
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
    vi.mocked(revealCards)
      .mockRejectedValueOnce(new Error('Unavailable'))
      .mockRejectedValueOnce({ code: 'not-found' });
    const { result } = renderHook(() => useAccountJournal('tester', draw.id));
    await act(async () => result.current.reveal(draw.id, [1]));
    expect(result.current.syncError).toContain('Unavailable');
    await act(async () => result.current.retrySync());
    await waitFor(() => expect(result.current.syncError).toBe(''));
    expect(revealCards).toHaveBeenCalledTimes(2);
    expect(createReading).not.toHaveBeenCalled();
  });

  it('requires a fresh delete choice after a failed deletion', async () => {
    vi.mocked(removeReading)
      .mockRejectedValueOnce(new Error('Denied'))
      .mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useAccountJournal('tester', draw.id));
    await act(async () => {
      await expect(result.current.remove(draw.id)).rejects.toThrow('Denied');
    });
    expect(result.current.deleteError).toContain('confirm again');
    act(() => result.current.retrySync());
    expect(removeReading).toHaveBeenCalledTimes(1);
    await act(async () => result.current.remove(draw.id));
    expect(result.current.deleteError).toBe('');
  });
});
