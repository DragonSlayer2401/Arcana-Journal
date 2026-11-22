import { expect, test, type Locator } from '@playwright/test';
import { desktopViewports, expectPageToFit } from '@/test/browser/viewport';

test.skip(({ isMobile }) => isMobile, 'These checks use desktop viewports.');

const expectStackedFields = async (dialog: Locator, count: number) => {
  const fields = await dialog.locator('input:not([type=checkbox]):visible').evaluateAll((inputs) =>
    inputs.map((input) => {
      const label = (input as HTMLInputElement).labels![0].getBoundingClientRect();
      const field = input.getBoundingClientRect();
      return {
        labelTop: label.top,
        labelBottom: label.bottom,
        labelLeft: label.left,
        top: field.top,
        bottom: field.bottom,
        left: field.left,
      };
    }),
  );
  expect(fields).toHaveLength(count);
  let previousBottom = 0;
  for (const field of fields) {
    expect(field.labelTop).toBeGreaterThanOrEqual(previousBottom);
    expect(field.top).toBeGreaterThanOrEqual(field.labelBottom);
    expect(field.left).toBeCloseTo(field.labelLeft, 0);
    previousBottom = field.bottom;
  }
};

for (const viewport of desktopViewports) {
  test.describe(`${viewport.width} × ${viewport.height}`, () => {
    test.use({ viewport });

    test('account forms and signup validation fit on screen', async ({ page }) => {
      await page.goto('/login');
      const signIn = page.getByRole('dialog', { name: 'Sign in' });
      await expect(signIn).toBeVisible();
      await expectStackedFields(signIn, 2);
      await expect(signIn.getByRole('heading', { name: 'Sign in' })).toBeInViewport({ ratio: 1 });
      await expect(signIn.getByRole('link', { name: 'Create account' })).toBeInViewport({
        ratio: 1,
      });

      await signIn.getByRole('link', { name: 'Forgot password?' }).click();
      const reset = page.getByRole('dialog', { name: 'Reset password' });
      await expect(reset.getByRole('button', { name: 'Send reset email' })).toBeInViewport({
        ratio: 1,
      });
      await reset.getByRole('button', { name: 'Close dialog' }).click();
      await expect(page).toHaveURL('/journal');
      await page.goto('/reset-password');
      await expect(page.getByRole('main').getByLabel('Email address')).toBeVisible();
      await expectPageToFit(page);

      await page.getByRole('banner').getByRole('link', { name: 'Create account' }).click();
      await page.getByLabel('Email address').fill('reader@example.test');
      await page.getByLabel('Password', { exact: true }).fill('example-password');
      await page.getByLabel('Confirm password').fill('different-password');
      const signup = page.getByRole('dialog', { name: 'Create account' });
      await signup.getByRole('button', { name: 'Create account' }).click();
      await expect(signup.getByRole('alert')).toContainText('Passwords don’t match');
      await expectStackedFields(signup, 3);
      await expect(signup.getByRole('heading', { name: 'Create account' })).toBeInViewport({
        ratio: 1,
      });
      await expect(signup.getByRole('link', { name: 'Sign in' })).toBeInViewport({ ratio: 1 });
    });

    test('an empty journal and a single reading fit, and a longer history remains reachable', async ({
      page,
    }) => {
      await page.goto('/journal');
      await expect(page.getByRole('link', { name: 'Go to Reading' })).toBeInViewport({ ratio: 1 });
      await expect(page.getByRole('button', { name: 'Import journal' })).toBeInViewport({
        ratio: 1,
      });
      await expectPageToFit(page);
      const bounds = (locator: Locator) =>
        locator.evaluate((element) => {
          const { left, right, top, bottom } = element.getBoundingClientRect();
          return { left, right, top, bottom };
        });
      const backups = page.getByRole('group', { name: 'Journal backups' });
      const main = await bounds(page.getByRole('main'));
      const title = await bounds(page.getByRole('heading', { level: 1 }));
      const account = await bounds(page.getByRole('region', { name: 'Journal account' }));
      const backupRow = await bounds(backups);
      const emptyAction = await bounds(page.getByRole('link', { name: 'Go to Reading' }));
      expect(account.top).toBeGreaterThanOrEqual(title.bottom);
      expect(account.left).toBeCloseTo(main.left, 0);
      expect(account.right).toBeCloseTo(main.right, 0);
      expect(backupRow.top).toBeGreaterThanOrEqual(account.bottom);
      expect(emptyAction.top).toBeGreaterThanOrEqual(backupRow.bottom);
      expect((emptyAction.left + emptyAction.right) / 2).toBeCloseTo(
        (main.left + main.right) / 2,
        0,
      );

      await page.getByRole('link', { name: 'Go to Reading' }).click();
      await page.getByRole('button', { name: /Custom/ }).click();
      await page.getByLabel('Number of cards').selectOption('10');
      await page
        .getByLabel(/What’s on your mind/)
        .fill('What should I reflect on today? '.repeat(63).slice(0, 2000));
      const draw = page.getByRole('button', { name: /Draw Cards/ });
      const journal = page.getByRole('navigation').getByRole('link', { name: /^Journal/ });
      await draw.click();
      await journal.click();
      const entries = page.getByRole('button', { name: /^Open reading:/ });
      await expect(entries).toHaveCount(1);
      await expect(entries).toBeInViewport({ ratio: 1 });
      await expect(page.getByRole('button', { name: 'Export journal' })).toBeInViewport({
        ratio: 1,
      });
      await expectPageToFit(page);
      const entry = await bounds(page.getByRole('article'));
      expect(entry.top).toBeGreaterThanOrEqual((await bounds(backups)).bottom);
      expect(entry.left).toBeCloseTo(main.left, 0);
      expect(entry.right).toBeCloseTo(main.right, 0);

      await page
        .getByRole('navigation')
        .getByRole('link', { name: 'Reading', exact: true })
        .click();
      for (let index = 0; index < 6; index++) {
        await draw.click();
        await page.getByRole('button', { name: 'New Reading' }).click();
      }
      await journal.click();
      await expect(entries).toHaveCount(7);
      await expect(entries.last()).not.toBeInViewport();
      await page.mouse.wheel(0, 10_000);
      await expect(entries.last()).toBeInViewport({ ratio: 1 });
    });

    test('the deck fits with one filtered row or zero matches and the full deck scrolls', async ({
      page,
    }) => {
      await page.goto('/deck');
      await expect(
        page.getByRole('button', { name: 'About, installation, and randomness' }),
      ).toBeEnabled();
      const search = page.getByLabel('Search cards');
      await search.fill('The H');
      const cards = page.getByRole('region', { name: 'Major Arcana' }).getByRole('button');
      await expect(cards).toHaveCount(4);
      const rowTops = await cards.evaluateAll((buttons) =>
        buttons.map((button) => button.getBoundingClientRect().top),
      );
      expect(new Set(rowTops).size).toBe(1);
      await expect(cards.last()).toBeInViewport({ ratio: 1 });
      await expectPageToFit(page);

      await search.fill('no such card');
      await expect(page.getByRole('link', { name: 'Show all cards' })).toBeInViewport({ ratio: 1 });
      await expectPageToFit(page);
      await search.fill('');
      const finalCard = page.getByRole('button', { name: 'King of Pentacles', exact: true });
      await expect(finalCard).toBeVisible();
      await expect(finalCard).not.toBeInViewport();
      await page.mouse.wheel(0, 10_000);
      await expect(finalCard).toBeInViewport({ ratio: 1 });
    });
  });
}
