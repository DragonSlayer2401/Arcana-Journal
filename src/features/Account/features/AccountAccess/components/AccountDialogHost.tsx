'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, type ReactNode } from 'react';
import { AccountAccess } from '../AccountAccess';
import {
  AccountDialogNavigation,
  useAccountDialog,
  type AccountPath,
} from '../hooks/useAccountDialog';
import { AccountEmailProvider } from './AccountEmailProvider';

export const AccountDialogHost = ({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) => {
  const { mode, showDialog, opening } = useAccountDialog();
  const router = useRouter();
  const opener = useRef<HTMLAnchorElement | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !showDialog && opener.current?.isConnected) {
      opener.current.focus({ preventScroll: true });
    }
    wasOpen.current = showDialog;
  }, [showDialog]);

  const navigate = (href: AccountPath, trigger: HTMLAnchorElement) => {
    // A native history entry updates Next's pathname without unmounting the background page.
    if (showDialog) {
      window.history.replaceState(
        { accountDialog: window.history.state?.accountDialog ?? 'direct' },
        '',
        href,
      );
    } else {
      opener.current = trigger;
      window.history.pushState({ accountDialog: 'return' }, '', href);
    }
  };
  const close = () => {
    if (window.history.state?.accountDialog === 'return') router.back();
    else router.replace('/journal', { scroll: false });
  };

  return (
    <AccountDialogNavigation.Provider value={opening ? null : navigate}>
      <AccountEmailProvider active={mode !== null}>
        <div className={className} inert={showDialog} aria-hidden={showDialog || undefined}>
          {children}
        </div>
        {showDialog && mode && <AccountAccess mode={mode} presentation="modal" onClose={close} />}
      </AccountEmailProvider>
    </AccountDialogNavigation.Provider>
  );
};

export const AccountRouteContent = ({
  children,
  background,
}: {
  children: ReactNode;
  background: ReactNode;
}) => {
  const { showDialog } = useAccountDialog();
  return showDialog ? background : children;
};
