import { expect, test, type Page } from '@playwright/test';
import { DECK } from '../src/data/deck';

const saved = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('stilllight.tarot.v1')!));
const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

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
    DECK.map((card) => card.id),
  );
  expect(results).toHaveLength(78);
  for (const item of results) {
    expect(item.error, item.id).toBeUndefined();
    expect(item.width, item.id).toBe(768);
    expect(item.height, item.id).toBe(1152);
  }
});

test('mobile layout, reveal, details, journal and reload retain the saved result', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Ready for offline use' })).toBeVisible();
  await noOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath('home.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page
    .getByLabel('What’s on your mind?', { exact: false })
    .fill('What deserves a little more attention?');
  await page.getByRole('button', { name: /Draw Cards/ }).dblclick();
  const original = (await saved(page)).readings[0];
  expect((await saved(page)).readings).toHaveLength(1);
  expect(original.cards).toHaveLength(3);
  expect(original.revealed).toEqual([false, false, false]);
  await page.getByRole('button', { name: 'Reveal card 1', exact: true }).click();
  await page.getByRole('button', { name: /View card details/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('navigation').getByRole('link', { name: /^Journal/ }).click();
  await page.getByRole('button', { name: /^Open reading:/ }).click();
  await page.reload();
  expect((await saved(page)).readings[0].cards).toEqual(original.cards);
  expect((await saved(page)).readings[0].revealed).toEqual([true, false, false]);
  await page.getByRole('button', { name: 'Reveal All' }).click();
  await expect(page.getByRole('button', { name: /View card details/ })).toHaveCount(3);
  await noOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath('reading.png'),
    fullPage: true,
    animations: 'disabled',
  });
  expect(errors).toEqual([]);
});

test('cached app reloads offline and makes fresh local pulls with meanings', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Ready for offline use' })).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Ready for offline use' })).toBeVisible();
  await page.getByRole('button', { name: /Draw Cards/ }).click();
  const reading = (await saved(page)).readings[0];
  await page.getByRole('button', { name: 'Reveal All' }).click();
  await page
    .getByRole('button', { name: /View card details/ })
    .first()
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.reload();
  expect((await saved(page)).readings[0].cards).toEqual(reading.cards);
  await page.getByRole('button', { name: 'New Reading' }).click();
  await page.getByRole('button', { name: /One card/ }).click();
  await page.getByRole('button', { name: /Draw Cards/ }).click();
  expect((await saved(page)).readings).toHaveLength(2);
  expect((await saved(page)).readings[0].cards).toHaveLength(1);
});

test('offline readiness detects a lost asset and repairs it when back online', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Ready for offline use' })).toBeVisible();
  await context.setOffline(true);
  await page.evaluate(async () => {
    const keys = await caches.keys();
    for (const key of keys)
      if (key.startsWith('stilllight-assets-')) {
        const cache = await caches.open(key);
        const requests = await cache.keys();
        const icon = requests.find((request) => request.url.endsWith('.png'));
        if (icon) await cache.delete(icon);
      }
    window.dispatchEvent(new Event('focus'));
  });
  await expect(page.getByRole('button', { name: 'Offline setup incomplete' })).toBeVisible();
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByRole('button', { name: 'Ready for offline use' })).toBeVisible();
});

test('small screens fit a ten-card reversed spread and respect reduced motion', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  for (const width of [320, 375, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await noOverflow(page);
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('button', { name: /Custom/ }).click();
  await page.getByRole('combobox', { name: 'Number of cards' }).selectOption('10');
  await page.getByRole('checkbox', { name: /Include reversals/ }).check();
  await page.getByRole('button', { name: /Draw Cards/ }).click();
  await page.getByRole('button', { name: 'Reveal All' }).click();
  await expect(page.getByRole('button', { name: /View card details/ })).toHaveCount(10);
  expect(
    new Set((await saved(page)).readings[0].cards.map((card: { cardId: string }) => card.cardId))
      .size,
  ).toBe(10);
  expect(
    await page
      .locator('.card-flipper')
      .first()
      .evaluate((node) => getComputedStyle(node).transitionDuration),
  ).toBe('0s');
  await noOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath('ten-cards.png'),
    fullPage: true,
    animations: 'disabled',
  });
});

test('manifest and every required cache entry are available without external requests', async ({
  page,
  request,
}) => {
  const external: string[] = [];
  page.on('request', (req) => {
    if (!req.url().startsWith('http://127.0.0.1:4173')) external.push(req.url());
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Ready for offline use' })).toBeVisible();
  const manifest = await (await request.get('/manifest.webmanifest')).json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
  for (const icon of manifest.icons) expect((await request.get(icon.src)).ok()).toBe(true);
  const apple = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
  expect((await request.get(apple!)).ok()).toBe(true);
  expect(external).toEqual([]);
});

test('long card captions remain upright and fit at 200% text size on a 320px screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem(
      'stilllight.tarot.v1',
      JSON.stringify({
        version: 1,
        settings: { mode: 'three', customCount: 5, reversals: true },
        activeId: 'caption-fixture',
        awaitingNewReading: true,
        readings: [
          {
            id: 'caption-fixture',
            createdAt: '2026-11-19T18:00:00.000Z',
            question: '',
            cards: [
              { cardId: 'minor-pentacles-12', orientation: 'reversed' },
              { cardId: 'minor-pentacles-13', orientation: 'upright' },
              { cardId: 'major-02', orientation: 'reversed' },
            ],
            revealed: [true, true, true],
          },
        ],
      }),
    );
  });
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Knight of Pentacles, reversed. View card details' }),
  ).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  const captions = await page.locator('.card-caption').evaluateAll((nodes) =>
    nodes.map((node) => {
      const caption = node as HTMLElement;
      const button = caption.closest('button')!;
      const bounds = caption.getBoundingClientRect();
      const buttonBounds = button.getBoundingClientRect();
      return {
        name: caption.querySelector('strong')!.textContent,
        transformed: getComputedStyle(caption).transform,
        insideFlipper: Boolean(caption.closest('.card-flipper')),
        clipped:
          caption.scrollWidth > caption.clientWidth || caption.scrollHeight > caption.clientHeight,
        withinButton:
          bounds.left >= buttonBounds.left - 1 &&
          bounds.right <= buttonBounds.right + 1 &&
          bounds.bottom <= buttonBounds.bottom + 1,
      };
    }),
  );
  expect(captions).toHaveLength(3);
  for (const caption of captions) {
    expect(caption.transformed, caption.name ?? '').toBe('none');
    expect(caption.insideFlipper, caption.name ?? '').toBe(false);
    expect(caption.clipped, caption.name ?? '').toBe(false);
    expect(caption.withinButton, caption.name ?? '').toBe(true);
  }
});
