import { expect, test } from '@playwright/test';
import { cardById } from '../src/features/Tarot/data/deck';

test.use({ javaScriptEnabled: false });

test('direct requests render each public page before JavaScript runs', async ({ page }) => {
  const pages = [
    ['/', /A question\. A card\./, 'Tarot Readings', 'custom tarot spread'],
    ['/deck', 'Card library', 'Card Library', '78 tarot cards'],
    ['/journal', 'Your reading journal.', 'Reading Journal', 'journal backups'],
    ['/login', 'Sign in', 'Sign in', 'Sign in to Arcana Journal'],
    ['/signup', 'Create account', 'Create account', 'verify your email'],
    ['/reset-password', 'Reset password', 'Reset password', 'password reset link'],
  ] as const;

  for (const [path, heading, title, description] of pages) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(`Arcana Journal · ${title}`);
    await expect(page.locator('head meta[name="description"]')).toHaveAttribute(
      'content',
      new RegExp(description),
    );
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    if (path === '/') {
      await expect(page.getByLabel(/What’s on your mind/)).toBeVisible();
      await expect(page.getByRole('button', { name: /Draw Cards/ })).toBeDisabled();
      await page.locator('summary').filter({ hasText: 'About Arcana Journal' }).click();
      await expect(page.getByRole('heading', { name: 'Fair draws, explained' })).toBeVisible();
    } else if (path === '/deck') {
      await expect(page.getByRole('button', { name: 'The Fool', exact: true })).toBeVisible();
      await expect(page.locator('.library-card')).toHaveCount(78);
      await expect(page.locator('.library-disclosure .card-meaning')).toHaveCount(156);
    } else if (path === '/journal') {
      await expect(page.getByText('Loading readings…')).toBeVisible();
      await expect(page.locator('.journal-entry')).toHaveCount(0);
    } else {
      await expect(page.getByLabel('Email address')).toBeVisible();
      await expect(page.locator('form button[type="submit"]')).toBeDisabled();
    }
  }
});

test('the server filters the deck and its meanings open without JavaScript', async ({ page }) => {
  await page.goto('/deck');
  await page.getByLabel('Search cards', { exact: true }).fill('queen');
  await page.getByLabel('Arcana or suit').selectOption('Cups');
  await page.getByRole('button', { name: 'Filter cards' }).click();
  await expect(page).toHaveURL(/\/deck\?q=queen&suit=Cups$/);
  await expect(page.locator('.library-card')).toHaveCount(1);
  const queen = cardById.get('minor-cups-13')!;
  await page.getByRole('button', { name: queen.name }).click();
  await expect(page.getByText(queen.upright.meaning, { exact: true })).toBeVisible();
  await expect(page.getByText(queen.reversed.meaning, { exact: true })).toBeVisible();
  await page.getByLabel('Search cards', { exact: true }).fill('unknown card');
  await page.getByRole('button', { name: 'Filter cards' }).click();
  await expect(page.getByRole('heading', { name: 'No matching cards' })).toBeVisible();
  await page.getByRole('link', { name: 'Show all cards' }).click();
  await expect(page.locator('.library-card')).toHaveCount(78);
});
