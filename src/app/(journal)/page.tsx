import type { Metadata } from 'next';
import { Reading } from '@/features/Tarot/features/Reading/Reading';

export const metadata: Metadata = {
  title: 'Tarot Readings',
  description:
    'Draw a one-card, three-card, or custom tarot spread and save your reading in Arcana Journal.',
};

export default Reading;
