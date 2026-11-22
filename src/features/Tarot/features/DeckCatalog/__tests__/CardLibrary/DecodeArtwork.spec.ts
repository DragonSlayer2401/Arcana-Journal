import { expect, test } from '@playwright/test';
import { tarotDeck } from '@/features/Tarot/data/deck';

test('all 78 illustrated cards decode from the offline cache at full portrait size', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Ready for offline use' })).toBeVisible();
  await context.setOffline(true);
  const results = await page.evaluate(
    async (ids) => {
      const results: { id: string; width: number; height: number; error?: string }[] = [];
      for (const id of ids) {
        const img = new Image();
        img.src = `/cards/${id}.webp`;
        try {
          await img.decode();
          results.push({ id, width: img.naturalWidth, height: img.naturalHeight });
        } catch {
          results.push({ id, width: 0, height: 0, error: 'Image decoding failed' });
        }
      }
      return results;
    },
    tarotDeck.map((card) => card.id),
  );
  expect(results).toHaveLength(78);
  for (const item of results) {
    expect(item.error, item.id).toBeUndefined();
    expect(item.width, item.id).toBe(768);
    expect(item.height, item.id).toBe(1152);
  }
});
