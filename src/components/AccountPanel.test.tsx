import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshAccount, sendVerification, signOutAccount } from '../cloud/journal';
import type { Reading } from '../domain/types';
import { AccountPanel } from './AccountPanel';
import { JournalTransfer } from './JournalTransfer';

vi.mock('../cloud/journal', () => ({
  refreshAccount: vi.fn(),
  sendVerification: vi.fn(),
  signOutAccount: vi.fn(),
}));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
beforeEach(() => vi.clearAllMocks());

const person = { uid: 'first', email: 'one@example.org', emailVerified: false };

describe('journal account controls', () => {
  it('links guests directly to the sign-in and signup pages', () => {
    render(<AccountPanel user={null} />, { wrapper: MemoryRouter });
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    expect(screen.getByRole('link', { name: 'Create account' })).toHaveAttribute('href', '/signup');
  });

  it('resends and checks verification and signs out after pending writes finish', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<AccountPanel user={person} signOutDisabled />, {
      wrapper: MemoryRouter,
    });
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Send verification email' }));
    expect(sendVerification).toHaveBeenCalledOnce();
    expect(screen.getByRole('status')).toHaveTextContent('Verification email sent');
    vi.mocked(refreshAccount).mockResolvedValueOnce({ ...person, emailVerified: true });
    await user.click(screen.getByRole('button', { name: 'Check verification' }));
    expect(screen.getByRole('status')).toHaveTextContent('Email address verified');
    rerender(<AccountPanel user={{ ...person, emailVerified: true }} />);
    expect(screen.queryByRole('button', { name: 'Check verification' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOutAccount).toHaveBeenCalledOnce();
  });

  it('previews the destination and counts before importing a device journal', async () => {
    const user = userEvent.setup();
    const entry: Reading = {
      id: 'saved-reading',
      createdAt: '2026-01-11T00:01:02Z',
      question: 'How can I pause?',
      cards: [{ cardId: 'major-01', orientation: 'upright' }],
      revealed: [true],
    };
    const counts = { added: 1, skipped: 0, updated: 0 };
    const onPreview = vi.fn().mockResolvedValue(counts);
    const onImport = vi.fn().mockResolvedValue(counts);
    render(
      <JournalTransfer
        accountEmail={person.email}
        deviceCount={1}
        getDeviceReadings={() => [entry]}
        onPreview={onPreview}
        onImport={onImport}
        onExport={vi.fn()}
      />,
    );
    const open = screen.getByRole('button', { name: 'Import this device’s journal' });
    await user.click(open);
    const review = within(await screen.findByRole('dialog', { name: 'Review journal import' }));
    expect(review.getByText(person.email)).toBeVisible();
    expect(review.getByText('New readings')).toBeVisible();
    expect(onPreview).toHaveBeenCalledWith([entry], expect.any(Function));
    await user.click(review.getByRole('button', { name: 'Cancel' }));
    expect(onImport).not.toHaveBeenCalled();
    await user.click(open);
    await user.click(await screen.findByRole('button', { name: 'Confirm import' }));
    expect(onImport).toHaveBeenCalledWith([entry], expect.any(Function));
    expect(await screen.findByText('Imported 1 reading.')).toBeVisible();
  });

  it('confirms a large backup before reading and still allows it to be restored', async () => {
    const user = userEvent.setup();
    const counts = { added: 0, skipped: 0, updated: 0 };
    const onPreview = vi.fn().mockResolvedValue(counts);
    const onImport = vi.fn().mockResolvedValue(counts);
    const confirmation = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    try {
      render(
        <JournalTransfer
          accountEmail={null}
          deviceCount={0}
          getDeviceReadings={() => []}
          onPreview={onPreview}
          onImport={onImport}
          onExport={vi.fn()}
        />,
      );
      const file = new File(['{"version":1,"readings":[]}'], 'large-backup.json', {
        type: 'application/json',
      });
      Object.defineProperty(file, 'size', { value: 65 * 1024 * 1024 });
      const input = screen.getByLabelText('Journal backup file');
      await user.upload(input, file);
      expect(confirmation).toHaveBeenCalledWith(expect.stringContaining('65 MiB'));
      expect(onPreview).not.toHaveBeenCalled();
      await user.upload(input, file);
      await user.click(await screen.findByRole('button', { name: 'Confirm import' }));
      expect(onImport).toHaveBeenCalledWith([], expect.any(Function));
    } finally {
      confirmation.mockRestore();
    }
  });
});
