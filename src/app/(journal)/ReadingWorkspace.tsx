'use client';

import type { ReactNode } from 'react';
import { useJournalSession } from '../../JournalProvider';
import { CARD_BY_ID } from '../../data/deck';
import { readingDateLabel } from '../../domain/readingDate';
import { CardArtwork } from '../../components/CardArtwork';
import { Icon } from '../../components/Icons';

export function ReadingWorkspace({
  children,
  cardBack,
}: {
  children: ReactNode;
  cardBack: ReactNode;
}) {
  const {
    account,
    reading,
    data,
    journalUid,
    newReading,
    revealedCount,
    reveal,
    setDetails,
    copyReading,
    copied,
  } = useJournalSession();
  return (
    <>
      {account.loadingActive && (
        <div className="empty-journal">
          <p role="status">Looking for your saved reading…</p>
          <button className="button button-secondary" onClick={newReading}>
            Start a new reading
          </button>
        </div>
      )}
      {!account.loadingActive && !reading && data.awaitingNewReading && (
        <section className="empty-journal">
          <Icon name="moon" size={46} />
          <h1>A little space to begin again.</h1>
          <p>
            {journalUid
              ? 'This reading is unavailable on this device.'
              : 'Your previous reading has been removed.'}
          </p>
          <button className="button button-gold" onClick={newReading}>
            <Icon name="spark" />
            New Reading
          </button>
        </section>
      )}
      {!reading && !data.awaitingNewReading && children}
      {reading && (
        <section className="reading-result" aria-label="Your reading">
          <div className="result-heading">
            <div>
              <p className="eyebrow">
                {readingDateLabel(reading.createdAt)} · {reading.cards.length}{' '}
                {reading.cards.length === 1 ? 'CARD' : 'CARDS'}
              </p>
              <h1>Your moment, drawn.</h1>
              <p className="reading-question">
                {reading.question || 'An open reading. A little space to listen.'}
              </p>
            </div>
            <button className="button button-secondary" onClick={newReading}>
              <Icon name="spark" />
              New Reading
            </button>
          </div>
          <div className="reveal-bar">
            <p role="status" aria-live="polite">
              {revealedCount === reading.cards.length
                ? 'Your spread is revealed. Tap a card to explore its meaning.'
                : `${revealedCount} of ${reading.cards.length} revealed · Tap a card when you’re ready.`}
            </p>
            <button
              className="text-button"
              onClick={() => reveal()}
              disabled={revealedCount === reading.cards.length}
            >
              Reveal All
            </button>
          </div>
          <div className={`spread-grid ${reading.cards.length === 1 ? 'single-card' : ''}`}>
            {reading.cards.map((drawn, index) => {
              const card = CARD_BY_ID.get(drawn.cardId)!;
              const isRevealed = reading.revealed[index];
              return (
                <div className="spread-slot" key={`${reading.id}-${index}`}>
                  <p className="position-label">CARD {String(index + 1).padStart(2, '0')}</p>
                  <button
                    className={`tarot-card ${isRevealed ? 'is-revealed' : ''}`}
                    aria-label={
                      isRevealed
                        ? `${card.name}, ${drawn.orientation}. View card details`
                        : `Reveal card ${index + 1}`
                    }
                    onClick={(event) => {
                      if (event.detail > 1) return;
                      isRevealed ? setDetails(index) : reveal(index);
                    }}
                  >
                    <span className="card-flipper">
                      <span className="card-face card-back" aria-hidden="true">
                        {cardBack}
                      </span>
                      <span className="card-face card-front" aria-hidden="true">
                        <CardArtwork card={card} reversed={drawn.orientation === 'reversed'} />
                      </span>
                    </span>
                    <span className="card-caption" aria-hidden="true">
                      <strong>{isRevealed ? card.name : 'Your card awaits'}</strong>
                      <small>{isRevealed ? drawn.orientation : 'Tap to reveal'}</small>
                    </span>
                  </button>
                  <p className="card-underlabel">
                    {isRevealed
                      ? card[drawn.orientation].keywords.slice(0, 2).join(' · ')
                      : 'Tap to reveal'}
                  </p>
                </div>
              );
            })}
          </div>
          <div className="reading-actions">
            <button className="button button-secondary" onClick={copyReading}>
              <Icon name={copied ? 'check' : 'copy'} />
              {copied ? 'Copied Reading' : 'Copy Reading'}
            </button>
            <span role="status">
              {copied
                ? 'Ready to paste into your chat or notes.'
                : 'Your cards stay exactly as drawn.'}
            </span>
          </div>
          <p className="reflection-note">
            {journalUid ? account.status : 'A prompt for reflection. You decide what resonates.'}
          </p>
        </section>
      )}
    </>
  );
}
