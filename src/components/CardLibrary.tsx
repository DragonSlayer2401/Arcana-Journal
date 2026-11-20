import { useState } from 'react';
import { DECK } from '../data/deck';
import type { TarotCard } from '../domain/types';
import { CardArtwork } from './CardArtwork';
import { Modal } from './Modal';
import './CardLibrary.css';

const collections = ['Major Arcana', 'Wands', 'Cups', 'Swords', 'Pentacles'] as const;
const collectionOf = (card: TarotCard) => card.suit ?? 'Major Arcana';

export const CardLibrary = () => {
  const [search, setSearch] = useState('');
  const [collection, setCollection] = useState('All cards');
  const [selected, setSelected] = useState<TarotCard | null>(null);
  const query = search.trim().toLowerCase();
  const matches = DECK.filter(
    (card) =>
      (collection === 'All cards' || collectionOf(card) === collection) &&
      card.name.toLowerCase().includes(query),
  );

  return (
    <section className="card-library" aria-labelledby="library-title">
      <header className="library-intro">
        <h1 id="library-title">Card library</h1>
        <p>Choose a card to explore its upright and reversed meanings.</p>
      </header>
      <div className="library-controls">
        <label>
          Search cards
          <input
            type="search"
            placeholder="Search by card name"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label>
          Arcana or suit
          <select value={collection} onChange={(event) => setCollection(event.target.value)}>
            <option>All cards</option>
            {collections.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="library-count" role="status">
        {matches.length} {matches.length === 1 ? 'card' : 'cards'}
      </p>
      {matches.length === 0 && (
        <div className="library-empty">
          <h2>No matching cards</h2>
          <button
            className="button button-secondary"
            onClick={() => {
              setSearch('');
              setCollection('All cards');
            }}
          >
            Show all cards
          </button>
        </div>
      )}
      {collections.map((name) => {
        const cards = matches.filter((card) => collectionOf(card) === name);
        if (!cards.length) return null;
        return (
          <section key={name} className="library-collection" aria-label={name}>
            <h2>{name}</h2>
            <ul className="library-grid">
              {cards.map((card) => (
                <li key={card.id}>
                  <button
                    className="library-card"
                    aria-haspopup="dialog"
                    onClick={() => setSelected(card)}
                  >
                    <CardArtwork card={card} loading="lazy" />
                    <span>{card.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {selected && (
        <Modal title={selected.name} onClose={() => setSelected(null)} className="library-dialog">
          <div className="card-detail">
            <div className="detail-art">
              <CardArtwork card={selected} />
            </div>
            <div>
              {(['upright', 'reversed'] as const).map((orientation) => (
                <section className="library-meaning" key={orientation}>
                  <h3>{orientation === 'upright' ? 'Upright' : 'Reversed'}</h3>
                  <p className="library-keywords">{selected[orientation].keywords.join(' · ')}</p>
                  <p className="card-meaning">{selected[orientation].meaning}</p>
                </section>
              ))}
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
};
