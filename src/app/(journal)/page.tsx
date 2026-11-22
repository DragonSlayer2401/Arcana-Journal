import type { Metadata } from 'next';
import { CardBackArtwork } from '../../components/CardIllustrations';
import { ReadingWorkspace } from './ReadingWorkspace';

export const metadata: Metadata = {
  title: 'Tarot Readings',
  description:
    'Draw a one-card, three-card, or custom tarot spread and save your reading in Arcana Journal.',
};

export default function ReadingPage() {
  const cardBack = <CardBackArtwork />;
  return (
    <ReadingWorkspace
      cardBack={cardBack}
      intro={
        <section className="intro">
          <p className="eyebrow">
            <span /> YOUR MOMENT OF STILLNESS <span />
          </p>
          <h1>
            A question. A card.
            <br />
            <em>A new perspective.</em>
          </h1>
          <p>
            Let the cards be a starting point.
            <br className="mobile-break" /> The meaning you find is yours.
          </p>
        </section>
      }
      deckPreview={
        <div className="deck-preview" aria-hidden="true">
          <div className="orbital orbital-one" />
          <div className="orbital orbital-two" />
          <span className="sky-star star-one">✦</span>
          <span className="sky-star star-two">✧</span>
          <span className="sky-star star-three">✦</span>
          <div className="preview-card preview-left">{cardBack}</div>
          <div className="preview-card preview-right">{cardBack}</div>
          <div className="preview-card preview-center">{cardBack}</div>
          <p className="deck-caption">78 CARDS · ENDLESS PERSPECTIVES</p>
        </div>
      }
    />
  );
}
