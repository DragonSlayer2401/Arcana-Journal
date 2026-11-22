'use client';

import { usePathname } from 'next/navigation';
import { createContext } from 'react';
import { useJournalSession } from '@/features/Journal/hooks/useJournalSession';

const accountModes = {
  '/login': 'signIn',
  '/signup': 'signUp',
  '/reset-password': 'reset',
} as const;

export type AccountPath = keyof typeof accountModes;
export const AccountDialogNavigation = createContext<
  ((href: AccountPath, trigger: HTMLAnchorElement) => void) | null
>(null);

export const useAccountDialog = () => {
  const pathname = usePathname();
  const { opening } = useJournalSession();
  const isAccountPath = Object.hasOwn(accountModes, pathname);
  const mode = isAccountPath ? accountModes[pathname as AccountPath] : null;
  const showDialog =
    !opening && mode !== null && (mode !== 'reset' || Boolean(window.history.state?.accountDialog));
  return { mode, showDialog, opening };
};
