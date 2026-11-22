import './browser/exclusiveLocks';
import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { TestRouter } from './TestRouter';
import { type AppData } from '@/features/Journal/utils/journalData';
import { guestStorageKey } from '@/features/Journal/features/GuestJournal/utils/guestStorage';

vi.mock('@/utils/pwa', () => ({ subscribeOfflineStatus: () => () => {} }));
vi.mock('@/services/Account/account.service', () => ({
  observeAccount: (change: (user: null) => void) => {
    change(null);
    return () => {};
  },
}));

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

export const renderApp = (ui: ReactNode, path = '/') =>
  render(ui, {
    wrapper: ({ children }) => <TestRouter path={path}>{children}</TestRouter>,
  });

export const stored = (): AppData => JSON.parse(localStorage.getItem(guestStorageKey)!);
export const useSecureSamples = (sample: (index: number) => number = () => 0) => {
  let index = 0;
  return vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((target) => {
    (target as Uint32Array)[0] = sample(index++);
    return target;
  });
};
export const drawButton = () => screen.getByRole('button', { name: /Draw Cards/ });
export const journalButton = () => screen.getByRole('link', { name: /^Journal/ });
