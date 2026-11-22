import { expect, test, type Page } from '@playwright/test';
import type { AppData } from '../src/domain/storage';

const savedData = (page: Page): Promise<AppData> =>
  page.evaluate(() => JSON.parse(localStorage.getItem('stilllight.tarot.v1')!));

for (const [path, title, navigation] of [
  ['/deck', 'Card library', 'Deck'],
  ['/journal', 'Your reading journal.', 'Journal'],
] as const) {
  test(`direct ${path} links survive online and offline refresh`, async ({ page, context }) => {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: navigation, exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('button', { name: 'Ready for offline use' })).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(path);
    await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    await context.setOffline(true);
    await page.reload();
    await expect(page).toHaveURL(path);
    await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('stilllight.tarot.v1'))).toBeNull();
    await page.getByRole('link', { name: 'Reading', exact: true }).click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('button', { name: /Draw Cards/ })).toBeVisible();
  });
}

test('account forms open at their own URLs and preserve the guest journal through offline navigation', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Ready for offline use' })).toBeVisible();
  await page.getByRole('button', { name: /Draw Cards/ }).click();
  await expect(page.getByRole('button', { name: 'Reveal card 1', exact: true })).toBeVisible();
  const original = await savedData(page);
  const header = page.getByRole('banner');
  await expect(header.getByRole('link', { name: 'Create account' })).toHaveAttribute(
    'href',
    '/signup',
  );
  await header.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/login');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: 'Create account' }).click();
  await expect(page).toHaveURL('/signup');
  await page.reload();
  await expect(page.getByLabel('Confirm password')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await context.setOffline(true);
  await page.goto('/reset-password');
  await expect(page.getByRole('heading', { level: 1, name: 'Reset password' })).toBeVisible();
  await header.getByRole('link', { name: /^Journal/ }).click();
  await expect(page.getByRole('button', { name: /^Open reading:/ })).toHaveCount(1);
  expect(await savedData(page)).toEqual(original);
});

test('back, forward and offline route refresh preserve one exact saved reading and dismiss dialogs', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Ready for offline use' })).toBeVisible();
  await page.getByLabel(/What’s on your mind/).fill('A reading across routes');
  await page.getByRole('checkbox', { name: /Include reversals/ }).check();
  await page.getByRole('button', { name: /Draw Cards/ }).click();
  await page.getByRole('button', { name: 'Reveal card 1', exact: true }).click();
  await expect(page.getByRole('button', { name: /View card details/ })).toBeVisible();
  const original = await savedData(page);
  expect(original.readings).toHaveLength(1);
  expect(original.readings[0].revealed).toEqual([true, false, false]);

  await page.getByRole('link', { name: /^Journal/ }).click();
  await expect(page).toHaveURL('/journal');
  await page.getByRole('link', { name: 'Deck', exact: true }).click();
  await expect(page).toHaveURL('/deck');
  await page.getByRole('button', { name: 'The Fool', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'The Fool' })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL('/journal');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Open reading:/ })).toHaveCount(1);
  await page.goBack();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('button', { name: /^Reveal card/ })).toHaveCount(2);
  await page.getByRole('button', { name: /View card details/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();

  await page.goForward();
  await expect(page).toHaveURL('/journal');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Delete reading: A reading across routes' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL('/deck');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await savedData(page)).toEqual(original);

  await context.setOffline(true);
  await page.reload();
  await expect(page).toHaveURL('/deck');
  await expect(page.getByRole('heading', { name: 'Card library', level: 1 })).toBeVisible();
  await page.goto('/journal');
  await expect(
    page.getByRole('heading', { name: 'Your reading journal.', level: 1 }),
  ).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL('/journal');
  await expect(page.getByRole('button', { name: /^Open reading:/ })).toHaveCount(1);
  await page.getByRole('button', { name: /^Open reading:/ }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('button', { name: /^Reveal card/ })).toHaveCount(2);
  await expect(page.getByRole('button', { name: /View card details/ })).toHaveCount(1);
  await expect(page.getByRole('button', { name: /Draw Cards/ })).toHaveCount(0);
  expect(await savedData(page)).toEqual(original);
});
