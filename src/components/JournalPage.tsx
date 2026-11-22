'use client';

import type { ReactNode } from 'react';
import { useJournalSession } from '../JournalProvider';
import { CARD_BY_ID } from '../data/deck';
import { lockJournal } from '../cloud/journal';
import { Icon } from './Icons';
import { AccountPanel } from './AccountPanel';
import { JournalTransfer } from './JournalTransfer';

export function JournalPage({
  heading,
  emptyState,
}: {
  heading: ReactNode;
  emptyState: ReactNode;
}) {
  const {
    readings,
    user,
    journalUid,
    account,
    opening,
    guestClearStatus,
    openReading,
    setConfirmDelete,
    requestClear,
    historyRevision,
    deviceCount,
    guestReadingsForTransfer,
    exportJournal,
    previewImport,
    importJournal,
  } = useJournalSession();
  return (
    <section className="journal">
      <div className="result-heading">
        <div>
          {!opening && (
            <p className="eyebrow">{journalUid ? 'ACCOUNT JOURNAL' : 'ON THIS DEVICE'}</p>
          )}
          {heading}
        </div>
        {!opening && (!journalUid || readings.length > 0) && (
          <button className="button button-secondary" onClick={requestClear}>
            <Icon name="trash" />
            Clear History
          </button>
        )}
      </div>
      {!journalUid && guestClearStatus && <p role="status">{guestClearStatus}</p>}
      {user !== undefined && (
        <>
          <AccountPanel
            key={user?.uid ?? 'signed-out'}
            user={user}
            syncStatus={account.status}
            signOutDisabled={account.pending}
            onLock={account.trusted && journalUid ? () => lockJournal(journalUid) : undefined}
          />
          <JournalTransfer
            historyRevision={historyRevision}
            accountEmail={journalUid ? (user?.email ?? null) : null}
            recoveryReadings={account.recoveryReadings}
            deletionStorageUnreadable={account.deletionStorageUnreadable}
            recoveryComplete={account.recoveryComplete}
            getRecoveryForExport={account.getRecoveryForExport}
            savedRecovery={account.savedRecovery}
            deviceCount={deviceCount}
            getDeviceReadings={guestReadingsForTransfer}
            onExport={exportJournal}
            onPreview={previewImport}
            onImport={importJournal}
          />
        </>
      )}

      {opening || account.loading ? (
        <p role="status">Loading readings…</p>
      ) : readings.length === 0 ? (
        emptyState
      ) : (
        <div className="journal-list">
          {readings.map((item) => {
            const date = new Date(item.createdAt);
            const dayLabel = date.toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            });
            return (
              <article className="journal-entry" key={item.id}>
                <div className="journal-date">
                  <span>{date.toLocaleDateString(undefined, { month: 'short' })}</span>
                  <strong>{date.getDate()}</strong>
                </div>
                <button
                  className="journal-open"
                  onClick={() => openReading(item.id)}
                  aria-label={`Open reading: ${item.question || 'Open reading'}, ${dayLabel}`}
                >
                  <span className="journal-meta">
                    {dayLabel} ·{' '}
                    {date.toLocaleTimeString(undefined, {
                      hour: 'numeric',
                      minute: '2-digit',
                    })}{' '}
                    · {item.cards.length} {item.cards.length === 1 ? 'card' : 'cards'}
                  </span>
                  <h2>{item.question || 'An open reading'}</h2>
                  <span className="journal-cards">
                    {item.cards
                      .map(
                        (card, i) =>
                          `${i + 1}. ${CARD_BY_ID.get(card.cardId)!.name}${card.orientation === 'reversed' ? ' (reversed)' : ' (upright)'}`,
                      )
                      .join(' · ')}
                  </span>
                  <span className="journal-open-label">Revisit reading</span>
                </button>
                <button
                  className="icon-button delete-button"
                  aria-label={`Delete reading: ${item.question || 'Open reading'}`}
                  onClick={() => setConfirmDelete(item)}
                >
                  <Icon name="trash" />
                </button>
              </article>
            );
          })}
        </div>
      )}
      {journalUid && account.hasMore && (
        <button className="button button-secondary" onClick={account.loadMore}>
          Load older readings
        </button>
      )}
      {!opening && (
        <p className="reflection-note">
          {journalUid
            ? 'Your account journal syncs across your signed-in devices.'
            : 'Stored only in this browser or installed app. Clearing its data can erase your journal.'}
        </p>
      )}
    </section>
  );
}
