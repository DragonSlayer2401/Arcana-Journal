import type { Metadata } from 'next';
import { DeckCatalog } from './DeckCatalog';
import '../../../components/CardLibrary.css';

export const metadata: Metadata = {
  title: 'Card Library',
  description:
    'Explore all 78 tarot cards, browse the Major Arcana and four suits, and read each card’s upright and reversed meanings.',
};

export default async function DeckPage({ searchParams }: PageProps<'/deck'>) {
  const { q, suit } = await searchParams;
  return (
    <DeckCatalog search={Array.isArray(q) ? q[0] : q} suit={Array.isArray(suit) ? suit[0] : suit} />
  );
}
