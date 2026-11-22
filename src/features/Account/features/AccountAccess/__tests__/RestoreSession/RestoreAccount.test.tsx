import {
  mount,
  restoreAccountOnMount,
  mockAccount,
  mockJournal,
  firstUser,
  deviceReading,
  firstReading,
} from '@/test/accountJournal';
import { TestApp, TestRouter } from '@/test/TestRouter';
import { act, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

describe('the public view before account restoration', () => {
  it.each(['/', '/login', '/signup', '/reset-password'])(
    'keeps form inputs disabled in the initial HTML for %s',
    (path) => {
      const readStorage = vi.spyOn(Storage.prototype, 'getItem');
      const container = document.createElement('div');
      container.innerHTML = renderToString(
        <TestRouter path={path}>
          <TestApp />
        </TestRouter>,
      );
      const form = container.querySelector('form')!;
      expect(form.querySelector('button[type="submit"]')).toBeDisabled();
      for (const field of form.querySelectorAll('input, textarea, select')) {
        expect(field).toBeDisabled();
      }
      expect(readStorage).not.toHaveBeenCalled();
      expect(mockAccount.observeAccount).not.toHaveBeenCalled();
    },
  );

  it('hydrates the shared journal HTML without revealing or reading a guest journal before identity is known', async () => {
    let restoreAccount!: Parameters<typeof mockAccount.observeAccount>[0];
    mockAccount.observeAccount.mockImplementation((listener) => {
      restoreAccount = listener;
      return () => {};
    });
    const page = (
      <TestRouter path="/journal">
        <TestApp />
      </TestRouter>
    );
    const readStorage = vi.spyOn(Storage.prototype, 'getItem');
    const container = document.createElement('div');
    container.innerHTML = renderToString(page);
    document.body.appendChild(container);
    const onRecoverableError = vi.fn();
    render(page, { container, hydrate: true, onRecoverableError });
    expect(screen.getByRole('heading', { name: 'Your reading journal.' })).toBeVisible();
    expect(screen.queryByText(deviceReading.question)).toBeNull();
    expect(readStorage).not.toHaveBeenCalled();
    expect(mockJournal.observeReadings).not.toHaveBeenCalled();
    expect(onRecoverableError).not.toHaveBeenCalled();

    act(() => restoreAccount(firstUser));
    expect(await screen.findByRole('heading', { name: firstReading.question })).toBeVisible();
    expect(screen.queryByText(deviceReading.question)).toBeNull();
  });

  it.each(['/login', '/signup', '/reset-password'])(
    'opens the journal for an existing session at %s',
    async (path) => {
      restoreAccountOnMount(firstUser);
      mount(path);
      expect(
        await screen.findByRole('heading', { level: 1, name: 'Your reading journal.' }),
      ).toBeVisible();
      expect(screen.getByRole('heading', { name: firstUser.email })).toBeVisible();
    },
  );
});
