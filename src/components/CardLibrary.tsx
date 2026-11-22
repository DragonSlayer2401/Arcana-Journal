'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { CARD_BY_ID } from '../data/deck';
import { CardArtwork } from './CardArtwork';
import { Modal } from './Modal';

interface Collection {
  name: string;
  cards: { name: string; entry: ReactNode }[];
}

interface Props {
  groups: Collection[];
  initialSearch: string;
  initialSuit: string;
}

export function CardLibrary({ groups, initialSearch, initialSuit }: Props) {
  const [search, setSearch] = useState(initialSearch);
  const [suit, setSuit] = useState(initialSuit);
  // A direct offline visit starts with the canonical /deck snapshot. Restore
  // its public filters from the address after the matching HTML has hydrated.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setSearch(params.get('q') ?? '');
    setSuit(params.get('suit') ?? '');
  }, [initialSearch, initialSuit]);

  const collection = groups.some((group) => group.name === suit) ? suit : '';
  const query = search.trim().toLowerCase();
  const matches = groups
    .filter((group) => !collection || group.name === collection)
    .map(({ name, cards }) => ({
      name,
      cards: cards.filter((card) => card.name.toLowerCase().includes(query)),
    }));
  const count = matches.reduce((total, group) => total + group.cards.length, 0);

  return (
    <>
      <form
        action="/deck"
        method="get"
        className="library-controls"
        onSubmit={(event) => {
          event.preventDefault();
          const url = new URL(window.location.href);
          if (search) url.searchParams.set('q', search);
          else url.searchParams.delete('q');
          if (collection) url.searchParams.set('suit', collection);
          else url.searchParams.delete('suit');
          window.history.replaceState(null, '', url);
        }}
      >
        <label>
          Search cards
          <input
            type="search"
            name="q"
            placeholder="Search by card name"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label>
          Arcana or suit
          <select name="suit" value={collection} onChange={(event) => setSuit(event.target.value)}>
            <option value="">All cards</option>
            {groups.map(({ name }) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        <noscript>
          <button className="button button-secondary" type="submit">
            Filter cards
          </button>
        </noscript>
      </form>
      <p className="library-count" role="status">
        {count} {count === 1 ? 'card' : 'cards'}
      </p>
      {count === 0 && (
        <div className="library-empty">
          <h2>No matching cards</h2>
          <Link
            className="button button-secondary"
            href="/deck"
            prefetch={false}
            onNavigate={() => {
              setSearch('');
              setSuit('');
            }}
          >
            Show all cards
          </Link>
        </div>
      )}
      {matches.map(
        ({ name, cards }) =>
          cards.length > 0 && (
            <section key={name} className="library-collection" aria-label={name}>
              <h2>{name}</h2>
              <ul className="library-grid">
                {cards.map((card) => (
                  <li key={card.name}>{card.entry}</li>
                ))}
              </ul>
            </section>
          ),
      )}
    </>
  );
}

export function LibraryCard({ cardId, children }: { cardId: string; children: ReactNode }) {
  const card = CARD_BY_ID.get(cardId)!;
  const [showDialog, setShowDialog] = useState(false);
  return (
    <>
      <details className="library-disclosure">
        <summary
          role="button"
          className="library-card"
          onClick={(event) => {
            event.preventDefault();
            setShowDialog(true);
          }}
        >
          <CardArtwork card={card} loading="lazy" />
          <span>{card.name}</span>
        </summary>
        {!showDialog && <div className="library-inline-meaning">{children}</div>}
      </details>
      {showDialog && (
        <Modal title={card.name} onClose={() => setShowDialog(false)} className="library-dialog">
          <div className="card-detail">
            <div className="detail-art">
              <CardArtwork card={card} />
            </div>
            <div>{children}</div>
          </div>
        </Modal>
      )}
    </>
  );
}
