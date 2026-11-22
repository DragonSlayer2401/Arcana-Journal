import type { Metadata } from 'next';
import { CardLibrary } from '../../../components/CardLibrary';
import '../../../components/CardLibrary.css';

export const metadata: Metadata = {
  title: 'Card Library',
  description:
    'Explore all 78 tarot cards, browse the Major Arcana and four suits, and read each card’s upright and reversed meanings.',
};

export default function DeckPage() {
  return (
    <section className="card-library" aria-labelledby="library-title">
      <header className="library-intro">
        <h1 id="library-title">Card library</h1>
        <p>Choose a card to explore its upright and reversed meanings.</p>
      </header>
      <CardLibrary />
    </section>
  );
}
