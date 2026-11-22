import { useRef, useState, type ReactNode } from 'react';
import { Modal } from '@/components/Modal';
import { CardArtwork } from '@/features/Tarot/components/CardArtwork';
import { cardById } from '@/features/Tarot/data/deck';
import type { Reading } from '@/features/Journal/readingTypes';
import { sameReadingContent } from '@/features/Journal/utils/readingIdentity';

interface Props {
  reading: Reading;
  cardBack: ReactNode;
  onReveal: (index: number) => void;
}

export const ReadingSpread = ({ reading, cardBack, onReveal }: Props) => {
  const lastCardButton = useRef<HTMLButtonElement>(null);
  const [details, setDetails] = useState<{ reading: Reading; index: number } | null>(null);
  if (
    details &&
    (!reading.revealed[details.index] || !sameReadingContent(details.reading, reading))
  )
    setDetails(null);
  const selected = details && details.reading.cards[details.index];
  const selectedCard = selected && cardById.get(selected.cardId);
  return (
    <>
      <div className={`spread-grid ${reading.cards.length === 1 ? 'single-card' : ''}`}>
        {reading.cards.map((drawn, index) => {
          const card = cardById.get(drawn.cardId)!;
          const isRevealed = reading.revealed[index];
          return (
            <div className="spread-slot" key={`${reading.id}-${index}`}>
              <p className="position-label">CARD {String(index + 1).padStart(2, '0')}</p>
              <button
                ref={index === reading.cards.length - 1 ? lastCardButton : undefined}
                className={`tarot-card ${isRevealed ? 'is-revealed' : ''}`}
                aria-label={
                  isRevealed
                    ? `${card.name}, ${drawn.orientation}. View card details`
                    : `Reveal card ${index + 1}`
                }
                onClick={(event) => {
                  if (event.detail > 1) return;
                  isRevealed ? setDetails({ reading, index }) : onReveal(index);
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
      {selected && selectedCard && details !== null && (
        <Modal
          title={selectedCard.name}
          onClose={() => setDetails(null)}
          className="card-detail-modal"
          fallbackFocusRef={lastCardButton}
        >
          <div className="card-detail">
            <div className="detail-art">
              <CardArtwork card={selectedCard} reversed={selected.orientation === 'reversed'} />
            </div>
            <div>
              <p className="eyebrow">
                CARD {details.index + 1} ·{' '}
                {selectedCard.arcana === 'major'
                  ? 'MAJOR ARCANA'
                  : selectedCard.suit?.toUpperCase()}
              </p>
              <span className="orientation-badge">{selected.orientation}</span>
              <div className="keyword-list">
                {selectedCard[selected.orientation].keywords.map((word) => (
                  <span key={word}>{word}</span>
                ))}
              </div>
              <p className="card-meaning">{selectedCard[selected.orientation].meaning}</p>
              <p className="field-hint">Notice what connects with your own experience.</p>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
};
