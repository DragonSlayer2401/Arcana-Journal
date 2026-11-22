export type Suit = 'Wands' | 'Cups' | 'Swords' | 'Pentacles';
export type Orientation = 'upright' | 'reversed';
export interface CardMeaning {
  keywords: readonly string[];
  meaning: string;
}
export interface TarotCard {
  id: string;
  name: string;
  arcana: 'major' | 'minor';
  suit?: Suit;
  rank: number;
  upright: CardMeaning;
  reversed: CardMeaning;
}
export interface DrawnCard {
  cardId: string;
  orientation: Orientation;
}
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
