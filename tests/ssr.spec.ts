import { expect, test } from '@playwright/test';

test.use({ javaScriptEnabled: false });

test('direct requests render each public page before JavaScript runs', async ({ page }) => {
  const pages = [
    ['/', /A question\. A card\./],
    ['/deck', 'Card library'],
    ['/journal', 'Your reading journal.'],
    ['/login', 'Sign in'],
    ['/signup', 'Create account'],
    ['/reset-password', 'Reset password'],
  ] as const;

  for (const [path, title] of pages) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    if (path === '/deck') {
      await expect(page.getByRole('button', { name: 'The Fool', exact: true })).toBeVisible();
      await expect(page.locator('.library-card')).toHaveCount(78);
    }
  }
});
