import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { devices, expect } from '@playwright/test';
import { verifyEmulatorEmail } from '../../../../../../../scripts/emulator-email.mjs';
import { authenticate, withApp } from '../../../../../../test/emulator/journalBrowser.mjs';

const reversals = (page) => page.getByRole('checkbox', { name: /Include reversals/ });
const instantReveal = (page) => page.getByRole('checkbox', { name: /Reveal cards instantly/ });

test(
  'another tab waits for offline reading preferences before signing out',
  withApp(async (base, browser) => {
    const context = await browser.newContext();
    await context.addInitScript(() =>
      Object.defineProperty(window, 'indexedDB', { value: undefined }),
    );
    const writer = await context.newPage();
    const email = 'offline-preferences-' + randomUUID() + '@example.test';
    const password = randomUUID();
    await authenticate(base, writer, email, password, { signup: true, trust: true });
    const sibling = await context.newPage();
    await sibling.goto(base + '/journal');
    const signOut = sibling.getByRole('button', { name: 'Sign out' });
    await expect(signOut).toBeEnabled();
    const remote = await browser.newPage();
    await authenticate(base, remote, email, password);
    await remote.goto(base);
    await expect(reversals(remote)).toBeEnabled();
    await writer.goto(base);
    await expect(reversals(writer)).toBeEnabled();

    await context.setOffline(true);
    await reversals(writer).check();
    await signOut.click();
    await expect(sibling.getByText(/another tab has unsynced journal changes/i)).toBeVisible();
    await context.setOffline(false);
    await expect(reversals(remote)).toBeChecked();
    await expect(async () => {
      if (await signOut.isVisible()) await signOut.click();
      await expect(sibling.getByRole('main').getByRole('link', { name: 'Sign in' })).toBeVisible({
        timeout: 1000,
      });
    }).toPass({ timeout: 10000 });
    await expect(reversals(writer)).not.toBeChecked();
  }),
);

test(
  'reading preferences sync across devices while each guest keeps their own settings',
  withApp(async (base, browser) => {
    const desktop = await browser.newPage();
    const phone = await browser.newPage({ ...devices['iPhone 13'] });
    const email = 'reading-preferences-' + randomUUID() + '@example.test';
    const password = randomUUID();

    await desktop.goto(base);
    await reversals(desktop).check();
    await instantReveal(desktop).check();
    await desktop.reload();
    await expect(reversals(desktop)).toBeChecked();
    await expect(instantReveal(desktop)).toBeChecked();

    await authenticate(base, desktop, email, password, {
      signup: true,
      verifyEmail: false,
      waitForSync: false,
    });
    await expect(desktop.getByRole('button', { name: 'Check verification' })).toBeVisible();
    await desktop.goto(base);
    await expect(reversals(desktop)).not.toBeChecked();
    await expect(instantReveal(desktop)).not.toBeChecked();
    await instantReveal(desktop).check();

    await authenticate(base, phone, email, password, { waitForSync: false });
    await phone.goto(base);
    await expect(instantReveal(phone)).toBeChecked();
    await expect(reversals(phone)).not.toBeChecked();
    await reversals(phone).check();
    await expect(reversals(desktop)).toBeChecked();
    await instantReveal(phone).uncheck();
    await expect(instantReveal(desktop)).not.toBeChecked();

    await desktop.goto(base + '/journal');
    await expect(desktop.getByRole('button', { name: 'Check verification' })).toBeVisible();
    await verifyEmulatorEmail(email);
    await desktop.getByRole('button', { name: 'Check verification' }).click();
    await expect(desktop.getByRole('button', { name: 'Check verification' })).toHaveCount(0);
    await desktop.goto(base);
    await expect(reversals(desktop)).toBeChecked();
    await expect(instantReveal(desktop)).not.toBeChecked();

    for (const page of [desktop, phone]) {
      await page.goto(base + '/journal');
      await page.getByRole('button', { name: 'Sign out' }).click();
      await expect(page.getByRole('main').getByRole('link', { name: 'Sign in' })).toBeVisible();
      await page.goto(base);
      await expect(reversals(page)).toBeChecked({ checked: page === desktop });
      await expect(instantReveal(page)).toBeChecked({ checked: page === desktop });
    }
  }),
);
