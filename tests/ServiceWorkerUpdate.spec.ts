import { expect, test, type Page } from '@playwright/test';
import type { AppData } from '@/features/Journal/utils/journalData';

type OfflineReply = { type?: string; ready?: boolean; version?: string };
const readOfflineReply = (
  page: Page,
  target: 'controller' | 'waiting' = 'controller',
): Promise<OfflineReply> =>
  page.evaluate(async (which) => {
    const worker =
      which === 'controller'
        ? navigator.serviceWorker.controller
        : (await navigator.serviceWorker.getRegistration())?.waiting;
    if (!worker) throw new Error(`No ${which} service worker`);
    return new Promise<OfflineReply>((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => {
        channel.port1.close();
        channel.port2.close();
        reject(new Error('Service worker did not report its offline state'));
      }, 8_000);
      channel.port1.onmessage = (event: MessageEvent<OfflineReply>) => {
        clearTimeout(timeout);
        channel.port1.close();
        channel.port2.close();
        resolve(event.data);
      };
      worker.postMessage({ type: 'CHECK_OFFLINE' }, [channel.port2]);
    });
  }, target);

const savedData = (page: Page): Promise<AppData> =>
  page.evaluate(() => JSON.parse(localStorage.getItem('stilllight.tarot.v1')!));

test('a cached update waits for all app windows to close and preserves the exact saved reading', async ({
  page,
  context,
  request,
}) => {
  expect((await request.post('/__test__/deploy/1')).ok()).toBe(true);
  const firstResponse = await page.goto('/');
  const buildId = await firstResponse!.headerValue('x-arcana-build');
  expect(buildId).toBeTruthy();
  await expect(page.getByRole('button', { name: 'Ready for offline use' })).toBeVisible();
  const originalWorker = await readOfflineReply(page);
  expect(originalWorker.ready).toBe(true);
  expect(originalWorker.version).toBeTruthy();

  await page.getByLabel(/What’s on your mind/).fill('A reading that outlasts an update');
  await page.getByRole('button', { name: /Draw Cards/ }).click();
  await page.getByRole('button', { name: 'Reveal card 1' }).click();
  await expect(page.getByRole('button', { name: /View card details/ })).toBeVisible();
  const original = await savedData(page);
  expect(original.readings[0].revealed).toEqual([true, false, false]);

  // Observe any unexpected automatic navigation while the new worker installs.
  let unexpectedReloads = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) unexpectedReloads += 1;
  });
  const newWorkerStarted = context.waitForEvent('serviceworker');
  expect((await request.post('/__test__/deploy/2')).ok()).toBe(true);
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) throw new Error('No service worker registration');
    await registration.update();
  });
  const updatedWorker = await newWorkerStarted;
  await page.waitForFunction(async () =>
    Boolean((await navigator.serviceWorker.getRegistration())?.waiting),
  );
  await expect(page.getByText(/An update is cached/)).toBeVisible();

  const waitingWorker = await readOfflineReply(page, 'waiting');
  expect(waitingWorker.ready).toBe(true);
  expect(waitingWorker.version).toBe(`${originalWorker.version}-update-test-v2`);
  expect((await readOfflineReply(page)).version).toBe(originalWorker.version);
  expect(await savedData(page)).toEqual(original);
  expect(unexpectedReloads).toBe(0);
  await expect(page.getByRole('button', { name: 'Reveal card 2' })).toBeVisible();
  const installedCaches = await page.evaluate(() => caches.keys());
  expect(installedCaches.filter((name) => name.startsWith('stilllight-assets-'))).toHaveLength(2);

  // A second app window also keeps the update waiting after the first closes.
  const secondWindow = await context.newPage();
  const oldDocument = await secondWindow.goto('/');
  expect(await oldDocument!.headerValue('x-arcana-build')).toBe(buildId);
  await expect(secondWindow.getByRole('button', { name: 'Ready for offline use' })).toBeVisible();
  expect((await readOfflineReply(secondWindow)).version).toBe(originalWorker.version);
  expect(await savedData(secondWindow)).toEqual(original);
  await page.close();
  expect((await readOfflineReply(secondWindow)).version).toBe(originalWorker.version);
  expect((await readOfflineReply(secondWindow, 'waiting')).version).toBe(waitingWorker.version);
  await secondWindow.close();
  expect(context.pages()).toHaveLength(0);

  // Inspect the real worker after the last client closes, without creating a new
  // client that would itself delay activation. No skipWaiting is sent anywhere.
  await expect
    .poll(() =>
      updatedWorker.evaluate(() => {
        const registration = (globalThis as unknown as { registration: ServiceWorkerRegistration })
          .registration;
        return registration.active?.state === 'activated' && registration.waiting === null;
      }),
    )
    .toBe(true);

  const reopened = await context.newPage();
  const newDocument = await reopened.goto('/');
  expect(await newDocument!.headerValue('x-arcana-build')).toBe(buildId + '-v2');
  await expect(reopened.getByRole('button', { name: 'Ready for offline use' })).toBeVisible();
  expect((await readOfflineReply(reopened)).version).toBe(waitingWorker.version);
  expect(await savedData(reopened)).toEqual(original);
  await expect(reopened.getByRole('button', { name: 'Reveal card 2' })).toBeVisible();
  await expect(reopened.getByRole('button', { name: /Draw Cards/ })).toHaveCount(0);
  const activeCaches = await reopened.evaluate(() => caches.keys());
  expect(activeCaches.filter((name) => name.startsWith('stilllight-assets-'))).toEqual([
    `stilllight-assets-${waitingWorker.version}`,
  ]);
});
