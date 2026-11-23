'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useJournalSession } from '../hooks/useJournalSession';
import { Icon } from '@/components/Icon';

interface HeaderLinkProps {
  href: string;
  className?: string;
  children: ReactNode;
  'aria-label'?: string;
  markCurrent?: boolean;
}

export const HeaderLink = ({
  href,
  className = '',
  markCurrent = true,
  ...props
}: HeaderLinkProps) => {
  const pathname = usePathname();
  const current = markCurrent && pathname === href;
  const { handleReadingLinkClick } = useJournalSession();
  return (
    <Link
      {...props}
      prefetch={false}
      href={href}
      onClick={href === '/' ? handleReadingLinkClick : undefined}
      aria-current={current ? 'page' : undefined}
      className={current ? `${className} active`.trim() : className}
    />
  );
};

export const SignedOutLinks = ({ children }: { children: ReactNode }) => {
  const { user } = useJournalSession();
  return user ? null : <div className="header-account-links">{children}</div>;
};

export const JournalCount = () => {
  const { journalUid, account, readings } = useJournalSession();
  if (readings.length === 0) return null;
  return (
    <span className="nav-count">
      {readings.length}
      {journalUid && account.hasMore ? '+' : ''}
    </span>
  );
};

export const AboutButton = () => {
  const { opening, setHelp } = useJournalSession();
  return (
    <button
      className="icon-button help-button"
      disabled={opening}
      aria-label="About, installation, and randomness"
      onClick={() => setHelp(true)}
    >
      <Icon name="info" />
    </button>
  );
};

export const JournalNotices = () => {
  const { account, journalUid, warning, preferenceWarning, retryPreferenceSync } =
    useJournalSession();
  return (
    <>
      {journalUid && account.deleteError && (
        <p className="notice warning" role="alert">
          {account.deleteError}
        </p>
      )}
      {journalUid && account.syncError && (
        <div className="notice warning" role="alert">
          {account.syncError}{' '}
          <button type="button" className="button button-secondary" onClick={account.retrySync}>
            Retry sync
          </button>
        </div>
      )}
      {warning && (
        <p className="notice warning" role="alert">
          {warning}
        </p>
      )}
      {preferenceWarning && (
        <div className="notice warning" role="alert">
          {preferenceWarning}{' '}
          {retryPreferenceSync && (
            <button type="button" className="button button-secondary" onClick={retryPreferenceSync}>
              Retry preference sync
            </button>
          )}
        </div>
      )}
    </>
  );
};

export const OfflineStatus = () => {
  const { opening, offline, setHelp } = useJournalSession();
  return (
    <button className="footer-status" disabled={opening} onClick={() => setHelp(true)}>
      <Icon name={offline === 'ready' ? 'check' : 'info'} size={15} />
      {offline === 'ready'
        ? 'Ready for offline use'
        : offline === 'checking'
          ? 'Preparing offline use…'
          : offline === 'error'
            ? 'Offline setup incomplete'
            : 'Offline setup unavailable'}
    </button>
  );
};
