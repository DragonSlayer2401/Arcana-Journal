'use client';

import type { ReactNode } from 'react';
import { useJournalSession } from '../../JournalProvider';
import { CARD_BY_ID } from '../../data/deck';
import { readingDateLabel } from '../../domain/readingDate';
import { CardArtwork } from '../../components/CardArtwork';
import { Icon } from '../../components/Icons';

const DRAW_OPTIONS = [
  { key: 'reversals', label: 'Include reversals', hint: 'Allow upright and reversed cards' },
  { key: 'instantReveal', label: 'Reveal cards instantly', hint: 'Draw your spread face up' },
] as const;

interface Props {
  intro: ReactNode;
  deckPreview: ReactNode;
  cardBack: ReactNode;
}

export function ReadingWorkspace({ intro, deckPreview, cardBack }: Props) {
  const {
    opening,
    account,
    reading,
    data,
    journalUid,
    count,
    question,
    setQuestion,
    updateSettings,
    draw,
    newReading,
    revealedCount,
    reveal,
    setDetails,
    copyReading,
    copied,
    error,
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
      {!reading && !data.awaitingNewReading && (
        <>
          {intro}
          <section className="reading-workspace" aria-label="Prepare your reading">
            {deckPreview}
            <form className="reading-form" onSubmit={draw}>
              <div className="form-heading">
                <span className="mini-star">✧</span>
                <h2>Make room for a reading</h2>
              </div>
              <fieldset disabled={opening}>
                <legend>Choose your spread</legend>
                <div className="mode-options">
                  {(
                    [
                      ['one', 'One card', 'A single focus'],
                      ['three', 'Three cards', 'Room to explore'],
                      ['custom', 'Custom', 'Your own spread'],
                    ] as const
                  ).map(([mode, label, description]) => (
                    <button
                      type="button"
                      key={mode}
                      aria-pressed={data.settings.mode === mode}
                      className={
                        data.settings.mode === mode ? 'mode-option selected' : 'mode-option'
                      }
                      onClick={() => updateSettings({ mode })}
                    >
                      <span className="mode-glyph" aria-hidden="true">
                        {mode === 'one' ? '▯' : mode === 'three' ? '▯▯▯' : '✧'}
                      </span>
                      <strong>{label}</strong>
                      <small>{description}</small>
                    </button>
                  ))}
                </div>
              </fieldset>
              {data.settings.mode === 'custom' && (
                <label className="custom-count">
                  Number of cards{' '}
                  <select
                    disabled={opening}
                    value={data.settings.customCount}
                    onChange={(event) =>
                      updateSettings({ customCount: Number(event.target.value) })
                    }
                  >
                    {Array.from({ length: 10 }, (_, i) => (
                      <option key={i + 1} value={i + 1}>
                        {i + 1}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="question-label" htmlFor="question">
                What’s on your mind? <span>optional</span>
              </label>
              <textarea
                disabled={opening}
                id="question"
                value={question}
                maxLength={2000}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="A question, an intention, or simply an open mind…"
                rows={3}
              />
              <p className="field-hint">A note for your journal. It never influences the draw.</p>
              {DRAW_OPTIONS.map(({ key, label, hint }) => (
                <label key={key} className="reading-setting">
                  <span>
                    <strong>{label}</strong>
                    <small>{hint}</small>
                  </span>
                  <input
                    type="checkbox"
                    disabled={opening}
                    checked={data.settings[key]}
                    onChange={(event) => updateSettings({ [key]: event.target.checked })}
                  />
                  <span className="switch" aria-hidden="true" />
                </label>
              ))}
              {error && (
                <p className="notice warning" role="alert">
                  {error}
                </p>
              )}
              <button disabled={opening} type="submit" className="button button-gold draw-button">
                <Icon name="spark" /> Draw Cards <span className="button-count">{count}</span>
              </button>
              <p className="draw-note">
                Every card has an equal chance. Every reading starts fresh.
              </p>
            </form>
          </section>
          <div className="principles">
            <span>
              <Icon name="moon" size={17} /> Your own quiet ritual
            </span>
            <span>
              <Icon name="check" size={17} /> Secure, unbiased draws
            </span>
            <span>
              <Icon name="book" size={17} />{' '}
              {journalUid ? 'Your synced reading journal' : 'A journal on your device'}
            </span>
          </div>
        </>
      )}

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
