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
  restoreAccountOnMount,
  setAccount,
  publish,
} from '@/test/accountJournal';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Reading } from '@/features/Journal/readingTypes';
import { freshData } from '@/features/Journal/utils/journalData';
import { collisionReadingId } from '@/features/Journal/utils/journalBackup';
import { guestStorageKey } from '@/features/Journal/features/GuestJournal/utils/guestStorage';
import { captureBackup } from '@/test/captureBackup';

const deviceImportButton = () => screen.queryByRole('button', { name: /Import this device/ });

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
    const form = within(await screen.findByRole('dialog', { name: 'Sign in' }));
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
    await user.click(await screen.findByRole('button', { name: /Import this device/ }));
    const preview = within(await screen.findByRole('dialog', { name: 'Review journal import' }));
    expect(preview.getByText(firstUser.email)).toBeVisible();
    expect(mockJournal.previewAccountImport.mock.lastCall?.slice(0, 2)).toEqual([
      firstUser.uid,
      [deviceReading],
    ]);
    expect(mockJournal.importAccountReadings).not.toHaveBeenCalled();
    await user.click(preview.getByRole('button', { name: 'Confirm import' }));
    expect(await screen.findByRole('heading', { name: deviceReading.question })).toBeVisible();
    await waitFor(() => expect(deviceImportButton()).toBeNull());
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
    expect(await screen.findByRole('button', { name: /Import this device/ })).toBeVisible();
  });

  it('recognizes an import beyond the first page and offers it again after its account copy is deleted', async () => {
    const original = localStorage.getItem(guestStorageKey);
    const occupiedId = buildReading(deviceReading.id, 'A different draw with the same old ID');
    const imported = {
      ...deviceReading,
      id: await collisionReadingId(deviceReading),
      sourceId: deviceReading.id,
      revealed: [true, true],
    };
    const recent = Array.from({ length: 50 }, (_, index) => ({
      ...buildReading(`recent-${index}`, `A newer draw ${index + 1}`),
      createdAt: '2026-11-23T12:00:00.000Z',
    }));
    restoreAccountOnMount(firstUser);
    records.set(firstUser.uid, [...recent, occupiedId]);
    mount();
    expect(await screen.findByRole('button', { name: 'Load older readings' })).toBeVisible();
    expect(await screen.findByRole('button', { name: /Import this device/ })).toBeVisible();
    act(() => publish(firstUser.uid, [...recent, occupiedId, imported]));
    expect(screen.queryByRole('heading', { name: deviceReading.question })).toBeNull();
    await waitFor(() => expect(deviceImportButton()).toBeNull());
    expect(screen.getByRole('button', { name: 'Import journal' })).toBeVisible();
    act(() => publish(firstUser.uid, [...recent, occupiedId]));
    expect(await screen.findByRole('button', { name: /Import this device/ })).toBeVisible();
    expect(localStorage.getItem(guestStorageKey)).toBe(original);
  });

  it('only counts saved copies when the offline journal shows other pending writes', async () => {
    restoreAccountOnMount(firstUser);
    mount();
    expect(await screen.findByRole('button', { name: /Import this device/ })).toBeVisible();

    const showOfflinePage = mockJournal.observeReadings.mock.lastCall![2];
    const entries = [firstReading, deviceReading];
    const offlinePage = { ...synced, fromCache: true, pending: true };
    act(() => showOfflinePage(entries, { ...offlinePage, storedReadings: [deviceReading] }));
    await waitFor(() => expect(deviceImportButton()).toBeNull());

    act(() => showOfflinePage(entries, { ...offlinePage, storedReadings: [firstReading] }));
    expect(await screen.findByRole('button', { name: /Import this device/ })).toBeVisible();
    expect(screen.getByRole('heading', { name: deviceReading.question })).toBeVisible();
  });

  it('offers new reveal progress and a separate matching draw saved by another guest tab', async () => {
    restoreAccountOnMount(firstUser);
    records.set(firstUser.uid, [deviceReading]);
    mount();
    expect(await screen.findByRole('heading', { name: deviceReading.question })).toBeVisible();
    await waitFor(() => expect(deviceImportButton()).toBeNull());

    const revealed = { ...deviceReading, revealed: [true, true] };
    const saveInGuestTab = (readings: Reading[]) => {
      const newValue = JSON.stringify({ ...freshData(), readings });
      localStorage.setItem(guestStorageKey, newValue);
      act(() => {
        window.dispatchEvent(
          new StorageEvent('storage', {
            key: guestStorageKey,
            newValue,
            storageArea: localStorage,
          }),
        );
      });
    };
    saveInGuestTab([revealed]);
    expect(await screen.findByRole('button', { name: /Import this device/ })).toBeVisible();
    act(() => publish(firstUser.uid, [revealed]));
    await waitFor(() => expect(deviceImportButton()).toBeNull());
    saveInGuestTab([revealed, { ...revealed, id: 'second-draw' }]);
    expect(await screen.findByRole('button', { name: /Import this device/ })).toBeVisible();
    expect(mockJournal.importAccountReadings).not.toHaveBeenCalled();
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
      await user.click(dialog.getByRole('button', { name: 'Cancel' }));
      act(() => publish(firstUser.uid, [edited, sibling]));
      await waitFor(() => expect(deviceImportButton()).toBeNull());
      expect(screen.getByRole('button', { name: 'Download guest backup' })).toBeVisible();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
});
