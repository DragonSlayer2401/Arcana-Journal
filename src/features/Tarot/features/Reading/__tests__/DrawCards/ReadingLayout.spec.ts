import { devices, expect, test, type Page } from '@playwright/test';
import { guestStorageKey } from '@/features/Journal/features/GuestJournal/utils/guestStorageKey';
import { savedJournal } from '@/test/browser/journal';
import { desktopViewports, expectPageToFit } from '@/test/browser/viewport';

const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

test.describe('desktop reading layout', () => {
  test.skip(({ isMobile }) => isMobile);

  for (const viewport of desktopViewports) {
    test(`draw and reveal spreads without scrolling at ${viewport.width} × ${viewport.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto('/');
      await expectPageToFit(page);

      const question = 'What deserves attention today?\n'.repeat(60).trim();
      for (const count of [1, 3, 6, 10]) {
        await page.getByRole('button', { name: /Custom/ }).click();
        await page.getByRole('combobox', { name: 'Number of cards' }).selectOption(String(count));
        await page.getByLabel('What’s on your mind?').fill(question);
        await expectPageToFit(page);
        await page.getByRole('button', { name: /Draw Cards/ }).click();
        await expect(page.getByRole('button', { name: /^Reveal card \d+$/ })).toHaveCount(count);
        await expectPageToFit(page);
        await page.getByRole('button', { name: 'Reveal All' }).click();
        await expect(page.getByRole('button', { name: /View card details/ })).toHaveCount(count);
        await expectPageToFit(page);
        if (count === 10) {
          await page.getByRole('button', { name: 'Read full question' }).click();
          await expect(page.getByRole('dialog', { name: 'Your question' })).toContainText(question);
          await page.getByRole('button', { name: 'Close dialog' }).click();
        }
        await page.getByRole('button', { name: 'New Reading' }).click();
      }
      await page.evaluate(() => {
        Object.defineProperty(window.crypto, 'getRandomValues', { value: undefined });
      });
      await page.getByRole('button', { name: /Draw Cards/ }).click();
      await expect(page.getByRole('main').getByRole('alert')).toContainText('No cards were drawn');
      await expectPageToFit(page);
    });
  }
});

test.describe('iPad landscape reading form', () => {
  const iPad = devices['iPad Pro 11 landscape'];
  test.use({
    userAgent: iPad.userAgent,
    deviceScaleFactor: iPad.deviceScaleFactor,
    screen: iPad.viewport,
    viewport: { width: 1194, height: 715 },
  });
  test.skip(({ browserName }) => browserName !== 'webkit');

  test('uses the available height for default and custom spreads', async ({ page }) => {
    await page.goto('/');
    const question = page.getByLabel('What’s on your mind?');
    await question.fill('A question\nA reflection\nAn intention');
    expect(await question.evaluate((field) => field.scrollHeight - field.clientHeight)).toBe(0);

    for (const spread of [/Three cards/, /Custom/]) {
      await page.getByRole('button', { name: spread }).click();
      await expectPageToFit(page);
      const gapBelowForm = await page.locator('form').evaluate((form) => {
        const footer = document.querySelector('footer')!;
        return footer.getBoundingClientRect().top - form.getBoundingClientRect().bottom;
      });
      expect(gapBelowForm).toBeGreaterThanOrEqual(0);
      expect(gapBelowForm).toBeLessThanOrEqual(48);
    }
  });
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
  await expect(page.getByRole('button', { name: 'Reveal card 1', exact: true })).toBeVisible();
  const original = (await savedJournal(page)).readings[0];
  expect((await savedJournal(page)).readings).toHaveLength(1);
  expect(original.cards).toHaveLength(3);
  expect(original.revealed).toEqual([false, false, false]);
  await page.getByRole('button', { name: 'Reveal card 1', exact: true }).click();
  await page.getByRole('button', { name: /View card details/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page
    .getByRole('navigation')
    .getByRole('link', { name: /^Journal/ })
    .click();
  await page.getByRole('button', { name: /^Open reading:/ }).click();
  await expect(page).toHaveURL('/');
  await page.reload();
  expect((await savedJournal(page)).readings[0].cards).toEqual(original.cards);
  expect((await savedJournal(page)).readings[0].revealed).toEqual([true, false, false]);
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
  await expect(page.getByRole('button', { name: 'Reveal card 1', exact: true })).toBeVisible();
  const reading = (await savedJournal(page)).readings[0];
  await page.getByRole('button', { name: 'Reveal All' }).click();
  await page
    .getByRole('button', { name: /View card details/ })
    .first()
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.reload();
  expect((await savedJournal(page)).readings[0].cards).toEqual(reading.cards);
  await page.getByRole('button', { name: 'New Reading' }).click();
  await page.getByRole('button', { name: /One card/ }).click();
  await page.getByRole('button', { name: /Draw Cards/ }).click();
  await expect(page.getByRole('button', { name: 'Reveal card 1', exact: true })).toBeVisible();
  expect((await savedJournal(page)).readings).toHaveLength(2);
  expect((await savedJournal(page)).readings[0].cards).toHaveLength(1);
});

test('small screens instantly reveal a ten-card spread with reversals and respect reduced motion', async ({
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
  await page.getByRole('checkbox', { name: /Reveal cards instantly/ }).check();
  await page.getByRole('button', { name: /Draw Cards/ }).click();
  await expect(page.getByRole('button', { name: /View card details/ })).toHaveCount(10);
  expect(
    new Set((await savedJournal(page)).readings[0].cards.map((card) => card.cardId)).size,
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

test('long card captions remain upright and fit at 200% text size on a 320px screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.addInitScript((key) => {
    localStorage.setItem(
      key,
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
  }, guestStorageKey);
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
