import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DECK } from '../data/deck';
import { CardArtwork } from './CardArtwork';

describe('bundled card illustrations', () => {
  it('uses the saved card ID and rotates only the illustration wrapper', () => {
    const view = render(<CardArtwork card={DECK[0]} reversed />);
    expect(view.container.querySelector('img')).toHaveAttribute('src', '/cards/major-00.webp');
    expect(view.container.firstElementChild).toHaveClass('artwork-reversed');
    view.rerender(<CardArtwork card={DECK[0]} />);
    expect(view.container.firstElementChild).not.toHaveClass('artwork-reversed');
  });

  it('uses a complete local symbolic fallback for failed artwork and retries a different card', () => {
    const view = render(<CardArtwork card={DECK[0]} reversed />);
    fireEvent.error(view.container.querySelector('img')!);
    expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.querySelector('svg')).not.toBeNull();
    expect(view.container.firstElementChild).toHaveClass('artwork-reversed');
    view.rerender(<CardArtwork card={DECK[1]} />);
    expect(view.container.querySelector('img')).toHaveAttribute('src', '/cards/major-01.webp');
  });
});
