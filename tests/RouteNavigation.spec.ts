import { expect, test } from '@playwright/test';
import { guestStorageKey } from '@/features/Journal/features/GuestJournal/utils/guestStorageKey';
import { savedJournal } from '@/test/browser/journal';

test('Reading and the logo return an open spread to the draw form and keep its journal entry', async ({
  page,
}) => {
  await page.goto('/');
  const draw = page.getByRole('button', { name: /Draw Cards/ });
  await draw.click();
  await page.getByRole('button', { name: 'Reveal card 1', exact: true }).click();
  await expect(page.getByRole('button', { name: /View card details/ })).toHaveCount(1);
  const [original] = (await savedJournal(page)).readings;

  await page.getByRole('link', { name: 'Reading', exact: true }).click();
  await expect(draw).toBeVisible();
  await page.getByRole('link', { name: /^Journal/ }).click();
  await page.getByRole('button', { name: /^Open reading:/ }).click();
  await expect(page.getByRole('button', { name: /View card details/ })).toHaveCount(1);

  await page.getByRole('link', { name: 'Arcana Journal, reading', exact: true }).click();
  await draw.click();
  await expect(page.getByRole('button', { name: /^Reveal card/ })).toHaveCount(3);
  const { readings } = await savedJournal(page);
  expect(readings).toHaveLength(2);
  expect(readings[1]).toEqual(original);
});

test('offline route changes keep a draft question in the mounted reading session', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Ready for offline use' })).toBeVisible();
  const question = page.getByLabel(/What’s on your mind/);
  await question.fill('A draft that exists only in this tab');
  await context.setOffline(true);
  await page.getByRole('link', { name: 'Deck', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Card library' })).toBeVisible();
  await page.getByRole('link', { name: 'Reading', exact: true }).click();
  await expect(question).toHaveValue('A draft that exists only in this tab');
  await page.goBack();
  await expect(page).toHaveURL('/deck');
  await page.goBack();
  await expect(question).toHaveValue('A draft that exists only in this tab');
});

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
    expect(await page.evaluate((key) => localStorage.getItem(key), guestStorageKey)).toBeNull();
    await page.getByRole('link', { name: 'Reading', exact: true }).click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('button', { name: /Draw Cards/ })).toBeVisible();
  });
}

test('account dialogs preserve the guest reading and accept direct visits on a small screen', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Ready for offline use' })).toBeVisible();
  await page.getByRole('button', { name: /Draw Cards/ }).click();
  await expect(page.getByRole('button', { name: 'Reveal card 1', exact: true })).toBeVisible();
  const original = await savedJournal(page);
  const header = page.getByRole('banner');
  await expect(header.getByRole('link', { name: 'Create account' })).toHaveAttribute(
    'href',
    '/signup',
  );
  const signInLink = header.getByRole('link', { name: 'Sign in' });
  await signInLink.focus();
  await signInLink.press('Enter');
  await expect(page).toHaveURL('/login');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAccessibleName('Sign in');
  await page.keyboard.press('Tab');
  await expect(dialog.locator(':focus')).toHaveCount(1);
  const email = dialog.getByLabel('Email address');
  await email.fill('reader@example.test');
  await dialog.getByRole('link', { name: 'Create account' }).click();
  await expect(page).toHaveURL('/signup');
  await expect(email).toHaveValue('reader@example.test');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL('/');
  await expect(signInLink).toBeFocused();
  await expect(page.getByRole('button', { name: 'Reveal card 1', exact: true })).toBeVisible();
  await header.getByRole('link', { name: /^Journal/ }).click();
  await expect(page.getByRole('button', { name: /^Open reading:/ })).toHaveCount(1);
  await page
    .getByRole('region', { name: 'Journal account' })
    .getByRole('link', { name: 'Create account' })
    .click();
  await expect(dialog).toHaveAccessibleName('Create account');
  await expect(email).toHaveValue('');
  await page.reload();
  await expect(dialog.getByLabel('Confirm password')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await context.setOffline(true);
  await page.goto('/reset-password');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'Reset password' })).toBeVisible();
  await header.getByRole('link', { name: /^Journal/ }).click();
  await expect(page.getByRole('button', { name: /^Open reading:/ })).toHaveCount(1);
  expect(await savedJournal(page)).toEqual(original);
});

test('account dialog history returns to the same filtered deck', async ({ page }) => {
  await page.goto('/deck');
  await expect(
    page.getByRole('button', { name: 'About, installation, and randomness' }),
  ).toBeEnabled();
  const search = page.getByLabel('Search cards');
  await search.fill('King of Cups');
  await expect(page.getByRole('button', { name: 'King of Cups' })).toBeVisible();
  const trigger = page.getByRole('banner').getByRole('link', { name: 'Create account' });
  await trigger.focus();
  await trigger.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Create account' });
  await expect(dialog).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL('/deck');
  await expect(dialog).toHaveCount(0);
  await expect(search).toHaveValue('King of Cups');
  await page.goForward();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /close/i }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL('/deck');
  await expect(search).toHaveValue('King of Cups');
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
  const original = await savedJournal(page);
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
  expect(await savedJournal(page)).toEqual(original);

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
  expect(await savedJournal(page)).toEqual(original);
});
