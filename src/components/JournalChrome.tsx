'use client';

import type { ComponentProps, ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useJournalSession } from '../JournalProvider';
import { Icon } from './Icons';

const NavLink = ({ href, className = '', ...props }: ComponentProps<typeof Link>) => {
  const current = usePathname() === href;
  return (
    <Link
      {...props}
      prefetch={false}
      href={href}
      aria-current={current ? 'page' : undefined}
      className={current ? `${className} active`.trim() : className}
    />
  );
};

export function JournalHeader({ children }: { children: ReactNode }) {
  const { user, journalUid, account, readings, handleReadingLinkClick, opening, setHelp } =
    useJournalSession();
  return (
    <header className="site-header">
      <div className="header-identity">
        <Link
          className="wordmark"
          prefetch={false}
          href="/"
          aria-label="Arcana Journal, reading"
          onClick={handleReadingLinkClick}
        >
          {children}
        </Link>
        {!user && (
          <div className="header-account-links">
            <NavLink href="/login">Sign in</NavLink>
            <NavLink className="header-signup" href="/signup">
              Create account
            </NavLink>
          </div>
        )}
      </div>
      <nav aria-label="Main navigation">
        <NavLink className="nav-button" href="/" onClick={handleReadingLinkClick}>
          <Icon name="cards" />
          <span>Reading</span>
        </NavLink>
        <NavLink className="nav-button" href="/deck">
          <Icon name="library" />
          <span>Deck</span>
        </NavLink>
        <NavLink className="nav-button" href="/journal">
          <Icon name="book" />
          <span>Journal</span>
          {readings.length > 0 && (
            <span className="nav-count">
              {readings.length}
              {journalUid && account.hasMore ? '+' : ''}
            </span>
          )}
        </NavLink>
        <button
          className="icon-button help-button"
          disabled={opening}
          aria-label="About, installation, and randomness"
          onClick={() => setHelp(true)}
        >
          <Icon name="info" />
        </button>
      </nav>
    </header>
  );
}

export function JournalNotices() {
  const { account, journalUid, warning } = useJournalSession();
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
    </>
  );
}

export function OfflineStatus() {
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
}
