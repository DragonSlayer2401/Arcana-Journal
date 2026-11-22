import type { DrawnCard } from '@/features/Tarot/cardTypes';

export interface Reading {
  id: string;
  /** Original portable ID when a collision required a different local ID. */
  sourceId?: string;
  createdAt: string;
  question: string;
  cards: DrawnCard[];
  revealed: boolean[];
}
export interface Settings {
  mode: 'one' | 'three' | 'custom';
  customCount: number;
  reversals: boolean;
  instantReveal: boolean;
}
