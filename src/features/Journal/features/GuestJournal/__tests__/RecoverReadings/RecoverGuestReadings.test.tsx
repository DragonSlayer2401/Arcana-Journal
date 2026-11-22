import {
  renderApp,
  stored,
  useSecureSamples,
  drawButton,
  journalButton,
} from '@/test/guestJournal';
import { TestApp } from '@/test/TestRouter';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { type AppData } from '@/features/Journal/utils/journalData';
import {
  guestStorageKey,
  guestRecoveryKey,
} from '@/features/Journal/features/GuestJournal/utils/guestStorage';
import { captureBackup } from '@/test/captureBackup';
import { webcrypto } from 'node:crypto';

describe('recovering a guest reading', () => {
  it('can revisit and export the session reading when storage rejects writes', async () => {
    const user = userEvent.setup();
    const random = useSecureSamples();
    const failedWrite = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    const backup = captureBackup();
    renderApp(<TestApp />);
    await user.click(drawButton());
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Your cards are still available in this session',
    );
    expect(screen.getAllByRole('button', { name: /^Reveal card/ })).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: 'Reveal All' }));
    const names = screen
      .getAllByRole('button', { name: /View card details/ })
      .map((button) => button.getAttribute('aria-label'));
    const session: AppData = JSON.parse(failedWrite.mock.lastCall![1]);
    await user.click(journalButton());
    await user.click(screen.getByRole('button', { name: 'Export journal' }));
    expect(await screen.findByRole('link', { name: 'Download backup' })).toHaveAttribute(
      'download',
    );
    expect(session.readings).toHaveLength(1);
    expect(await backup()).toEqual({ version: 1, readings: session.readings });
    await user.click(screen.getByRole('button', { name: /^Open reading:/ }));
    expect(
      screen
        .getAllByRole('button', { name: /View card details/ })
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(names);
    expect(random).toHaveBeenCalledTimes(77);
    expect(localStorage.getItem(guestStorageKey)).toBeNull();
  });

  it('preserves a sibling draw when the next guest storage read fails once', async () => {
    const user = userEvent.setup();
    const backup = captureBackup();
    const first = within(renderApp(<TestApp />).container);
    const sibling = within(renderApp(<TestApp />).container);
    await user.type(sibling.getByRole('textbox'), 'Sibling draw');
    await user.click(sibling.getByRole('button', { name: /Draw Cards/ }));
    const saved = stored();
    await user.type(first.getByRole('textbox'), 'First tab draw');
    const get = Storage.prototype.getItem;
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (
      this: Storage,
      key: string,
    ) {
      if (key === guestStorageKey) {
        read.mockRestore();
        throw new DOMException('Storage unavailable', 'SecurityError');
      }
      return get.call(this, key);
    });
    await user.click(first.getByRole('button', { name: /Draw Cards/ }));
    expect(first.getByRole('alert')).toHaveTextContent('still available in this session');
    expect(stored()).toEqual(saved);
    await user.click(first.getByRole('link', { name: /^Journal/ }));
    await user.click(first.getByRole('button', { name: 'Export journal' }));
    await first.findByRole('link', { name: 'Download backup' });
    const file = await backup();
    expect(file.readings).toHaveLength(2);
    expect(file.readings).toContainEqual(saved.readings[0]);
    expect(file.readings.some((reading) => reading.question === 'First tab draw')).toBe(true);
  });

  it('keeps the open spread usable after another guest tab starts a new reading', async () => {
    const user = userEvent.setup();
    const first = within(renderApp(<TestApp />).container);
    await user.click(first.getByRole('button', { name: /Draw Cards/ }));
    const original = stored().readings[0];
    const second = within(renderApp(<TestApp />).container);
    await user.click(second.getByRole('button', { name: 'New Reading' }));
    await user.click(first.getByRole('button', { name: 'Reveal card 1' }));
    expect(first.getAllByRole('button', { name: /View card details/ })).toHaveLength(1);
    expect(second.getByRole('button', { name: /Draw Cards/ })).toBeEnabled();
    expect(stored().readings[0]).toEqual({ ...original, revealed: [true, false, false] });
    await user.click(first.getByRole('button', { name: 'New Reading' }));
    await user.click(first.getByRole('button', { name: /Draw Cards/ }));
    expect(stored().readings).toHaveLength(2);
  });

  it('restores a guest reveal alongside a separately imported copy without restoring a sibling deletion', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('crypto', webcrypto);
    const backup = captureBackup();
    const view = renderApp(<TestApp />);
    await user.type(screen.getByLabelText(/What’s on your mind/), 'Delete in the other tab');
    await user.click(drawButton());
    await user.click(screen.getByRole('button', { name: 'New Reading' }));
    await user.click(drawButton());
    const original = stored();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    await user.click(screen.getByRole('button', { name: 'Reveal card 2' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Your cards are still available');
    const sibling = { ...original.readings[0], id: 'import-' + 'a'.repeat(64) };
    const persisted = { ...original, readings: [sibling], activeId: sibling.id };
    localStorage.setItem(guestStorageKey, JSON.stringify(persisted));
    await user.click(journalButton());
    await user.click(screen.getByRole('button', { name: 'Export journal' }));
    expect(await screen.findByRole('link', { name: 'Download backup' })).toBeVisible();
    const file = await backup();
    const edited = { ...original.readings[0], revealed: [false, true, false] };
    expect(file.readings).toHaveLength(2);
    expect(file.readings).toEqual(expect.arrayContaining([sibling, edited]));
    expect(stored()).toEqual(persisted);
    view.unmount();
    renderApp(<TestApp />, '/journal');
    await user.upload(
      screen.getByLabelText('Journal backup file'),
      new File([JSON.stringify(file)], 'guest.json', { type: 'application/json' }),
    );
    await user.click(await screen.findByRole('button', { name: 'Confirm import' }));
    expect(stored().readings).toHaveLength(2);
    expect(stored().readings).toEqual(expect.arrayContaining([sibling, edited]));
  });

  it('preserves unreadable storage on export and import and still allows a new draw', async () => {
    localStorage.setItem(guestStorageKey, '{broken');
    const user = userEvent.setup();
    useSecureSamples();
    renderApp(<TestApp />);
    expect(screen.getByRole('alert')).toHaveTextContent('Saved data could not be read');
    await user.click(journalButton());
    await user.click(screen.getByRole('button', { name: 'Export journal' }));
    expect(
      await screen.findByText(/saved journal could not be read to create a backup/i),
    ).toHaveAttribute('role', 'alert');
    expect(screen.queryByRole('link', { name: 'Download backup' })).not.toBeInTheDocument();
    await user.upload(
      screen.getByLabelText('Journal backup file'),
      new File(['{"version":1,"readings":[]}'], 'backup.json', { type: 'application/json' }),
    );
    expect(await screen.findByText(/saved journal could not be read to merge/i)).toBeVisible();
    expect(localStorage.getItem(guestStorageKey)).toBe('{broken');
    await user.click(screen.getByRole('link', { name: 'Reading' }));
    await user.click(drawButton());
    expect(stored().readings).toHaveLength(1);
    expect(localStorage.getItem(guestRecoveryKey)).toBe('{broken');
  });
});
