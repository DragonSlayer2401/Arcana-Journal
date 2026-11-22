'use client';

import type { ReactNode } from 'react';
import { useJournalSession } from '@/features/Journal/hooks/useJournalSession';
import { cardById } from '@/features/Tarot/data/deck';
import { Icon } from '@/components/Icon';

export const JournalHistory = ({ emptyState }: { emptyState: ReactNode }) => {
  const { opening, account, readings, journalUid, openReading, setConfirmDelete } =
    useJournalSession();
  return (
    <>
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
                          `${i + 1}. ${cardById.get(card.cardId)!.name}${card.orientation === 'reversed' ? ' (reversed)' : ' (upright)'}`,
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
      {journalUid && (
        <p className="reflection-note">Your account journal syncs across your signed-in devices.</p>
      )}
    </>
  );
};
