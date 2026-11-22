import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CARD_BY_ID } from '../data/deck';
import type { Reading } from '../domain/types';
import { Icon } from './Icons';

interface Props {
  readings: Reading[];
  onOpen: (id: string) => void;
  onRequestDelete: (reading: Reading) => void;
  onRequestClear: () => void;
  account: boolean;
  loading?: boolean;
  hasMore?: boolean;
  onLoadMore: () => void;
  children: ReactNode;
}

export const JournalPage = ({
  readings,
  onOpen,
  onRequestDelete,
  onRequestClear,
  account,
  loading,
  hasMore,
  onLoadMore,
  children,
}: Props) => (
  <section className="journal">
    <div className="result-heading">
      <div>
        <p className="eyebrow">{account ? 'ACCOUNT JOURNAL' : 'ON THIS DEVICE'}</p>
        <h1>Your reading journal.</h1>
      </div>
      {readings.length > 0 && (
        <button className="button button-secondary" onClick={onRequestClear}>
          <Icon name="trash" />
          Clear History
        </button>
      )}
    </div>
    {children}
    {loading ? (
      <p role="status">Loading readings…</p>
    ) : readings.length === 0 ? (
      <div className="empty-journal">
        <Icon name="book" size={46} />
        <h2>A fresh page awaits.</h2>
        <p>Your readings will find a home here.</p>
        <Link className="button button-gold" to="/">
          Go to Reading
        </Link>
      </div>
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
                onClick={() => onOpen(item.id)}
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
                onClick={() => onRequestDelete(item)}
              >
                <Icon name="trash" />
              </button>
            </article>
          );
        })}
      </div>
    )}
    {hasMore && (
      <button className="button button-secondary" onClick={onLoadMore}>
        Load older readings
      </button>
    )}
    <p className="reflection-note">
      {account
        ? 'Your account journal syncs across your signed-in devices.'
        : 'Stored only in this browser or installed app. Clearing its data can erase your journal.'}
    </p>
  </section>
);
