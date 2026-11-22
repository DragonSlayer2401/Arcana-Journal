import { expect, test } from '@playwright/test';

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
      if (key.startsWith('arcana-journal-assets-')) {
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
