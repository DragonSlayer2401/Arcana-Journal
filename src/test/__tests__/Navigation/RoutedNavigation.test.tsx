import { renderApp, stored, useSecureSamples, drawButton } from '@/test/guestJournal';
import { TestApp } from '@/test/TestRouter';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { guestStorageKey } from '@/features/Journal/features/GuestJournal/utils/guestStorage';

describe('routed navigation', () => {
  it.each([
    ['/deck', 'Card library', 'Deck'],
    ['/journal', 'Your reading journal.', 'Journal'],
  ])('opens %s directly without creating a reading', (path, heading, navigation) => {
    const random = useSecureSamples();
    renderApp(<TestApp />, path);
    expect(screen.getByRole('heading', { name: heading, level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: navigation })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Reading' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Deck' })).toHaveAttribute('href', '/deck');
    expect(screen.getByRole('link', { name: /^Journal/ })).toHaveAttribute('href', '/journal');
    expect(random).not.toHaveBeenCalled();
    expect(localStorage.getItem(guestStorageKey)).toBeNull();
  });

  it('returns from an empty journal through the Go to Reading link without drawing', async () => {
    const user = userEvent.setup();
    const random = useSecureSamples();
    renderApp(<TestApp />, '/journal');
    const returnLink = screen.getByRole('link', { name: 'Go to Reading' });
    expect(returnLink).toHaveAttribute('href', '/');
    await user.click(returnLink);
    expect(drawButton()).toBeEnabled();
    expect(screen.getByRole('link', { name: 'Reading' })).toHaveAttribute('aria-current', 'page');
    expect(random).not.toHaveBeenCalled();
  });

  it('keeps a draft question when returning to the drawing form', async () => {
    const user = userEvent.setup();
    renderApp(<TestApp />);
    await user.type(screen.getByLabelText(/What’s on your mind/), 'An unfinished question');
    await user.click(screen.getByRole('link', { name: 'Deck' }));
    await user.click(screen.getByRole('link', { name: 'Reading' }));
    await user.click(screen.getByRole('link', { name: 'Arcana Journal, reading' }));
    expect(screen.getByLabelText(/What’s on your mind/)).toHaveValue('An unfinished question');
    expect(localStorage.getItem(guestStorageKey)).toBeNull();
  });

  it('keeps the current spread open on a modified Reading link click', async () => {
    const user = userEvent.setup();
    renderApp(<TestApp />);
    await user.click(drawButton());
    const original = stored();
    await user.keyboard('{Control>}');
    await user.click(screen.getByRole('link', { name: 'Reading' }));
    await user.keyboard('{/Control}');
    expect(screen.getByRole('button', { name: 'Reveal card 1' })).toBeVisible();
    expect(stored()).toEqual(original);
  });
});
