import {
  mockAccount,
  mockJournal,
  firstUser,
  nextUser,
  buildReading,
  firstReading,
  nextReading,
  mount,
  records,
  setAccount,
  publish,
  restoreAccountOnMount,
} from '@/test/accountJournal';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { captureBackup } from '@/test/captureBackup';
import * as journalActivity from '@/services/Journal/journalActivity';

describe('exporting an account journal', () => {
  it.each(['clear', 'unknown'] as const)(
    'exports every page and labels the file when sibling activity is %s',
    async (siblingState) => {
      const user = userEvent.setup();
      restoreAccountOnMount(firstUser);
      const checkOtherTabs = vi
        .spyOn(journalActivity, 'checkSiblingRecovery')
        .mockResolvedValue(siblingState);
      const readings = Array.from({ length: 51 }, (_, index) =>
        buildReading('entry-' + index, 'Reading ' + index),
      );
      records.set(firstUser.uid, readings);
      mockJournal.exportAccountJournal.mockResolvedValue(JSON.stringify({ version: 1, readings }));
      const createURL = vi.fn((_file: Blob) => 'blob:account-export');
      vi.stubGlobal(
        'URL',
        class extends URL {
          static createObjectURL = createURL;
          static revokeObjectURL = vi.fn();
        },
      );
      const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      try {
        mount();
        expect(screen.queryByRole('heading', { name: 'Reading 50' })).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Export journal' }));
        expect(await screen.findByRole('link', { name: 'Download backup' })).toHaveAttribute(
          'href',
          'blob:account-export',
        );
        expect(mockJournal.exportAccountJournal).toHaveBeenCalledWith(
          firstUser.uid,
          false,
          expect.any(Function),
        );
        const filename = screen
          .getByRole('link', { name: 'Download backup' })
          .getAttribute('download');
        expect(filename).toContain('cloud-and-this-tab');
        expect(screen.getByText(/Other tabs may have unsynced readings/)).toBeVisible();
        const blob = createURL.mock.calls[0][0];
        const json = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.readAsText(blob);
        });
        expect(JSON.parse(json).readings).toEqual(readings);
        await user.click(screen.getByRole('button', { name: 'Load older readings' }));
        expect(screen.getByRole('heading', { name: 'Reading 50' })).toBeVisible();
      } finally {
        checkOtherTabs.mockRestore();
        download.mockRestore();
        vi.unstubAllGlobals();
      }
    },
  );

  it.each(['clear', 'lock', 'sign out', 'pagehide'])(
    'drops the previous account export when a delayed response arrives after %s',
    async (action) => {
      const user = userEvent.setup();
      restoreAccountOnMount(firstUser);
      let notifyLock!: () => void;
      mockAccount.observeJournalLock.mockImplementation((_uid, notify) => {
        notifyLock = notify;
        return () => {};
      });
      const checkOtherTabs = vi
        .spyOn(journalActivity, 'checkSiblingRecovery')
        .mockResolvedValue('clear');
      let finishExport!: (json: string) => void;
      mockJournal.exportAccountJournal.mockReturnValueOnce(
        new Promise((resolve) => {
          finishExport = resolve;
        }),
      );
      const currentReadings =
        action === 'clear' ? [] : [action === 'sign out' ? nextReading : firstReading];
      mockJournal.exportAccountJournal.mockResolvedValue(
        JSON.stringify({ version: 1, readings: currentReadings }),
      );
      const currentBackup = captureBackup();
      try {
        mount();
        await user.click(screen.getByRole('button', { name: 'Export journal' }));
        await waitFor(() => expect(mockJournal.exportAccountJournal).toHaveBeenCalledTimes(1));
        if (action === 'clear') {
          mockJournal.reviewAccountClear.mockResolvedValueOnce({
            uid: firstUser.uid,
            documents: [],
          });
          mockJournal.clearReadings.mockImplementationOnce(async () => publish(firstUser.uid, []));
          await user.click(screen.getByRole('button', { name: 'Clear History' }));
          await user.click(await screen.findByRole('button', { name: 'Clear All Readings' }));
          await waitFor(() => expect(mockJournal.clearReadings).toHaveBeenCalledTimes(1));
        } else if (action === 'lock') {
          act(() => {
            mockAccount.isJournalLocked.mockReturnValue(true);
            notifyLock();
          });
          expect(screen.getByRole('heading', { name: 'Journal locked' })).toBeVisible();
        } else if (action === 'pagehide') {
          act(() => {
            window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
            window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
          });
        } else {
          await user.click(screen.getByRole('button', { name: 'Sign out' }));
          act(() => setAccount(nextUser));
          expect(screen.getByRole('heading', { name: nextUser.email })).toBeVisible();
        }
        await act(async () =>
          finishExport(JSON.stringify({ version: 1, readings: [firstReading] })),
        );
        expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
        expect(screen.queryByRole('link', { name: 'Download backup' })).toBeNull();
        if (action === 'lock')
          act(() => {
            mockAccount.isJournalLocked.mockReturnValue(false);
            notifyLock();
          });
        await user.click(screen.getByRole('button', { name: 'Export journal' }));
        await screen.findByRole('link', { name: 'Download backup' });
        expect((await currentBackup()).readings).toEqual(currentReadings);
      } finally {
        checkOtherTabs.mockRestore();
        vi.unstubAllGlobals();
        vi.mocked(HTMLAnchorElement.prototype.click).mockRestore();
      }
    },
  );

  it('stops the download if another tab acquires unsynced readings during export', async () => {
    const user = userEvent.setup();
    restoreAccountOnMount(firstUser);
    const checkOtherTabs = vi
      .spyOn(journalActivity, 'checkSiblingRecovery')
      .mockResolvedValueOnce('clear')
      .mockResolvedValueOnce('busy');
    mockJournal.exportAccountJournal.mockResolvedValue(
      JSON.stringify({ version: 1, readings: [firstReading] }),
    );
    try {
      mount();
      await user.click(screen.getByRole('button', { name: 'Export journal' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        /another tab has unsynced journal changes/i,
      );
      expect(screen.queryByRole('link', { name: 'Download backup' })).toBeNull();
    } finally {
      checkOtherTabs.mockRestore();
    }
  });
});
