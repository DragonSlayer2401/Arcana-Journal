import { CardLibrary, LibraryCard } from './components/CardLibrary';
import { tarotDeck } from '@/features/Tarot/data/deck';

const suits = ['Major Arcana', 'Wands', 'Cups', 'Swords', 'Pentacles'] as const;

const groups = suits.map((name) => ({
  name,
  cards: tarotDeck
    .filter((card) => (card.suit ?? 'Major Arcana') === name)
    .map((card) => ({
      name: card.name,
      entry: (
        <LibraryCard cardId={card.id}>
          {(['upright', 'reversed'] as const).map((orientation) => (
            <section className="library-meaning" key={orientation}>
              <h3>{orientation === 'upright' ? 'Upright' : 'Reversed'}</h3>
              <p className="library-keywords">{card[orientation].keywords.join(' · ')}</p>
              <p className="card-meaning">{card[orientation].meaning}</p>
            </section>
          ))}
        </LibraryCard>
      ),
    })),
}));

export const DeckCatalog = ({ search = '', suit = '' }: { search?: string; suit?: string }) => {
  return (
    <section className="card-library" aria-labelledby="library-title">
      <header className="library-intro">
        <h1 id="library-title">Card library</h1>
        <p>Choose a card to explore its upright and reversed meanings.</p>
      </header>
      <CardLibrary groups={groups} initialSearch={search} initialSuit={suit} />
    </section>
  );
};
