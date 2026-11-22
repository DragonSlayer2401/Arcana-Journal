import {
  mockAccount,
  mockJournal,
  firstUser,
  nextUser,
  buildReading,
  deviceReading,
  firstReading,
  nextReading,
  synced,
  mount,
  goToJournal,
  records,
  setAccount,
  publish,
} from '@/test/accountJournal';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { freshData } from '@/features/Journal/utils/journalData';
import { guestStorageKey } from '@/features/Journal/features/GuestJournal/utils/guestStorage';
import { captureBackup } from '@/test/captureBackup';

describe('importing a guest journal into an account', () => {
  it('keeps unverified accounts in the guest journal and imports only after verification and confirmation', async () => {
    const user = userEvent.setup();
    const original = localStorage.getItem(guestStorageKey);
    mockAccount.signIn.mockImplementation(async () =>
      setAccount({ ...firstUser, emailVerified: false }),
    );
    mockAccount.refreshAccount.mockImplementation(async () => {
      setAccount(firstUser);
      return firstUser;
    });
    mockJournal.previewAccountImport.mockResolvedValue({ added: 1, updated: 0, skipped: 0 });
    mockJournal.importAccountReadings.mockImplementation(async (uid, entries) => {
      publish(uid, [...records.get(uid)!, ...entries]);
      return { added: 1, updated: 0, skipped: 0 };
    });
    mount();
    expect(screen.getByRole('heading', { name: deviceReading.question })).toBeVisible();
    await user.click(within(screen.getByRole('main')).getByRole('link', { name: 'Sign in' }));
    const form = within(screen.getByRole('main'));
    await user.type(form.getByLabelText('Email address'), firstUser.email);
    await user.type(form.getByLabelText('Password'), 'test-password');
    await user.click(form.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: firstUser.email })).toBeVisible();
    expect(screen.getByRole('heading', { name: deviceReading.question })).toBeVisible();
    expect(screen.queryByRole('heading', { name: firstReading.question })).toBeNull();
    expect(screen.queryByRole('button', { name: /Import this device/ })).toBeNull();
    expect(mockJournal.observeReadings).not.toHaveBeenCalled();
    expect(mockJournal.observeReading).not.toHaveBeenCalled();
    expect(mockJournal.previewAccountImport).not.toHaveBeenCalled();
    expect(mockJournal.importAccountReadings).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Check verification' }));
    expect(await screen.findByRole('heading', { name: firstReading.question })).toBeVisible();
    expect(screen.queryByRole('heading', { name: deviceReading.question })).toBeNull();
    expect(mockJournal.importAccountReadings).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /Import this device/ }));
    const preview = within(await screen.findByRole('dialog', { name: 'Review journal import' }));
    expect(preview.getByText(firstUser.email)).toBeVisible();
    expect(mockJournal.previewAccountImport.mock.lastCall?.slice(0, 2)).toEqual([
      firstUser.uid,
      [deviceReading],
    ]);
    expect(mockJournal.importAccountReadings).not.toHaveBeenCalled();
    await user.click(preview.getByRole('button', { name: 'Confirm import' }));
    expect(await screen.findByRole('heading', { name: deviceReading.question })).toBeVisible();
    expect(localStorage.getItem(guestStorageKey)).toBe(original);
    const previousListener = mockJournal.observeReadings.mock.lastCall![2];
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(screen.queryByRole('heading', { name: firstReading.question })).toBeNull();
    expect(screen.getByRole('heading', { name: deviceReading.question })).toBeVisible();
    act(() => setAccount(nextUser));
    // A callback already queued by the old session must not cross the account boundary.
    act(() => previousListener([firstReading], synced));
    expect(screen.getByRole('heading', { name: nextReading.question })).toBeVisible();
    expect(screen.queryByRole('heading', { name: firstReading.question })).toBeNull();
    expect(screen.queryByRole('heading', { name: deviceReading.question })).toBeNull();
  });

  it('downloads and previews unsaved guest changes after signing in even when another tab changed the journal', async () => {
    const user = userEvent.setup();
    const backup = captureBackup();
    mockJournal.previewAccountImport.mockResolvedValue({ added: 2, updated: 0, skipped: 0 });
    const sibling = buildReading('sibling', 'Saved in another guest tab');
    try {
      mount();
      await user.click(screen.getByRole('button', { name: /^Open reading:/ }));
      const rejectWrite = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      });
      await user.click(screen.getByRole('button', { name: 'Reveal card 1' }));
      expect(
        await screen.findByText(/your cards are still available in this session/i),
      ).toBeVisible();
      rejectWrite.mockRestore();
      const saved = JSON.stringify({ ...freshData(), readings: [sibling] });
      localStorage.setItem(guestStorageKey, saved);
      act(() => setAccount(firstUser));
      await goToJournal(user);
      await user.click(screen.getByRole('button', { name: 'Download guest backup' }));
      expect(await screen.findByRole('link', { name: 'Download backup' })).toHaveAttribute(
        'download',
        expect.stringContaining('-guest-'),
      );
      const file = await backup();
      const edited = { ...deviceReading, revealed: [true, true] };
      expect(file.readings).toHaveLength(2);
      expect(file.readings).toEqual(expect.arrayContaining([edited, sibling]));
      expect(mockJournal.exportAccountJournal).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: /Import this device/ }));
      const dialog = within(await screen.findByRole('dialog', { name: 'Review journal import' }));
      expect(dialog.getByText(firstUser.email)).toBeVisible();
      expect(mockJournal.previewAccountImport.mock.lastCall?.slice(0, 2)).toEqual([
        firstUser.uid,
        file.readings,
      ]);
      expect(mockJournal.importAccountReadings).not.toHaveBeenCalled();
      expect(localStorage.getItem(guestStorageKey)).toBe(saved);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
});
