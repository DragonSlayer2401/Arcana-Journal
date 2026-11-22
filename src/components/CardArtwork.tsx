import { useState } from 'react';
import type { TarotCard } from '../domain/types';
import { SymbolicCardArtwork } from './CardIllustrations';

/** Bundled illustrations are presentation only; card IDs always come from the saved draw. */
export const CardArtwork = ({
  card,
  reversed = false,
  loading,
}: {
  card: TarotCard;
  reversed?: boolean;
  loading?: 'eager' | 'lazy';
}) => {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const source = `/cards/${card.id}.webp`;
  return (
    <span className={`card-illustration${reversed ? ' artwork-reversed' : ''}`} aria-hidden="true">
      {failedSource === source ? (
        <SymbolicCardArtwork card={card} />
      ) : (
        <img
          src={source}
          alt=""
          width={768}
          height={1152}
          decoding="async"
          loading={loading}
          onError={() => setFailedSource(source)}
        />
      )}
    </span>
  );
};
