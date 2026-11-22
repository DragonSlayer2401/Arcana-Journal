import { expect, test } from '@playwright/test';
import { cardById, tarotDeck } from '@/features/Tarot/data/deck';

const cardNamePattern = new RegExp(`^(?:${tarotDeck.map((card) => card.name).join('|')})$`);

test('a filtered deck URL restores the same cards on an offline reload', async ({
  page,
  context,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/deck?q=queen&suit=Cups');
  await expect(page.getByRole('button', { name: 'Ready for offline use' })).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('button', { name: cardNamePattern })).toHaveCount(1);
  await page.getByRole('button', { name: 'Queen of Cups', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Queen of Cups' })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('the full card library, filters, artwork and both meanings work offline on small screens', async ({
  page,
  context,
}, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Ready for offline use' })).toBeVisible();
  await page.getByRole('button', { name: /Draw Cards/ }).click();
  await expect(page.getByRole('button', { name: 'Reveal card 1', exact: true })).toBeVisible();
  const saved = await page.evaluate(() => localStorage.getItem('stilllight.tarot.v1'));
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('link', { name: 'Deck', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Card library', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: cardNamePattern })).toHaveCount(78);

  for (const width of [320, 375, 430]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `${width}px library`,
    ).toBe(true);
  }
  await page.setViewportSize({ width: 320, height: 844 });
  await page.getByLabel('Search cards', { exact: true }).fill('queen');
  await page.getByRole('combobox', { name: 'Arcana or suit' }).selectOption({ label: 'Cups' });
  await expect(page.getByRole('button', { name: cardNamePattern })).toHaveCount(1);
  await page.getByRole('button', { name: 'Queen of Cups', exact: true }).click();
  const queen = cardById.get('minor-cups-13')!;
  const dialog = page.getByRole('dialog', { name: queen.name });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Upright', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Reversed', { exact: true })).toBeVisible();
  await expect(dialog.getByText(queen.upright.meaning, { exact: true })).toBeVisible();
  await expect(dialog.getByText(queen.reversed.meaning, { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      dialog
        .locator('img')
        .first()
        .evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBe(768);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('offline-library-detail.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  expect(await page.evaluate(() => localStorage.getItem('stilllight.tarot.v1'))).toBe(saved);
  await page.getByRole('link', { name: 'Reading', exact: true }).click();
  await expect(page.getByRole('button', { name: /Draw Cards/ })).toBeVisible();
});
