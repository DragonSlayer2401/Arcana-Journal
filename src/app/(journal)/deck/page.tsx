import type { Metadata } from 'next';
import { DeckCatalog } from '@/features/Tarot/features/DeckCatalog/DeckCatalog';

export const metadata: Metadata = {
  title: 'Card Library',
  description:
    'Explore all 78 tarot cards, browse the Major Arcana and four suits, and read each card’s upright and reversed meanings.',
};

const DeckPage = async ({ searchParams }: PageProps<'/deck'>) => {
  const { q, suit } = await searchParams;
  return (
    <DeckCatalog search={Array.isArray(q) ? q[0] : q} suit={Array.isArray(suit) ? suit[0] : suit} />
  );
};

export default DeckPage;
