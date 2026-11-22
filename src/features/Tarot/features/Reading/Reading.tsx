import { CardBackArtwork } from '@/features/Tarot/components/CardIllustrations';
import { ReadingWorkspace } from './components/ReadingWorkspace';
import {
  ReadingForm,
  SpreadSelector,
  QuestionInput,
  DrawControls,
  DrawError,
} from './components/ReadingForm';

export const Reading = () => {
  const cardBack = <CardBackArtwork />;
  return (
    <ReadingWorkspace cardBack={cardBack}>
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
      <div className="reading-workspace">
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
        <ReadingForm>
          <div className="form-heading">
            <span className="mini-star">✧</span>
            <h2>Make room for a reading</h2>
          </div>
          <SpreadSelector />
          <label className="question-label" htmlFor="question">
            What’s on your mind? <span>optional</span>
          </label>
          <QuestionInput />
          <p className="field-hint">A note for your journal. It never influences the draw.</p>
          <DrawControls />
          <p className="draw-note">Every card has an equal chance. Every reading starts fresh.</p>
        </ReadingForm>
        <DrawError />
      </div>
    </ReadingWorkspace>
  );
};
