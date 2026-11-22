import { expect, test } from '@playwright/test';
import { importFile, savedJournal } from '@/test/browser/journal';

for (const single of [true, false]) {
  test(`guest ${single ? 'deletion' : 'clear'} preserves a new draw in another tab and its next reveal`, async ({
    page,
    context,
  }) => {
    await page.goto('/');
    await page.getByLabel(/What’s on your mind/).fill('First spread');
    await page.getByRole('button', { name: /Draw Cards/ }).click();
    await page.getByRole('link', { name: /^Journal/ }).click();
    await page
      .getByRole('button', { name: single ? 'Delete reading: First spread' : 'Clear History' })
      .click();

    const sibling = await context.newPage();
    await sibling.goto('/');
    await sibling.getByRole('button', { name: 'New Reading' }).click();
    await sibling.getByLabel(/What’s on your mind/).fill('Later spread');
    await sibling.getByRole('button', { name: /Draw Cards/ }).click();
    await expect(sibling.getByRole('button', { name: 'Reveal card 1' })).toBeVisible();
    const later = (await savedJournal(sibling)).readings[0];

    await page
      .getByRole('dialog')
      .getByRole('button', { name: single ? 'Delete Reading' : 'Clear All Readings' })
      .click();
    await expect(page.getByRole('heading', { name: 'Later spread' })).toBeVisible();
    await expect.poll(async () => (await savedJournal(page)).readings).toEqual([later]);
    await sibling.getByRole('button', { name: 'Reveal card 1' }).click();
    await expect(sibling.getByRole('button', { name: /View card details/ })).toBeVisible();
    expect((await savedJournal(sibling)).readings).toEqual([
      { ...later, revealed: [true, false, false] },
    ]);
  });
}

test('a stale guest confirmation keeps a replacement with the same ID', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await page.getByLabel(/What’s on your mind/).fill('Original spread');
  await page.getByRole('button', { name: /Draw Cards/ }).click();
  await page.getByRole('link', { name: /^Journal/ }).click();
  await page.getByRole('button', { name: 'Delete reading: Original spread' }).click();
  const sibling = await context.newPage();
  await sibling.goto('/journal');
  const replacement = {
    ...(await savedJournal(sibling)).readings[0],
    question: 'Replacement spread',
  };
  await sibling.getByRole('button', { name: 'Clear History' }).click();
  await sibling.getByRole('button', { name: 'Clear All Readings' }).click();
  await expect(sibling.getByRole('heading', { name: 'A fresh page awaits.' })).toBeVisible();
  await importFile(sibling, {
    name: 'replacement.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ version: 1, readings: [replacement] })),
  });
  await sibling.getByRole('button', { name: 'Confirm import' }).click();
  await expect(sibling.getByRole('heading', { name: replacement.question })).toBeVisible();

  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(/This reading changed in another tab/)).toBeVisible();
  expect((await savedJournal(page)).readings).toEqual([replacement]);
});

test('a confirmed guest deletion keeps a replacement saved while waiting for the write lock', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await page.getByLabel(/What’s on your mind/).fill('Original spread');
  await page.getByRole('button', { name: /Draw Cards/ }).click();
  await page.getByRole('link', { name: /^Journal/ }).click();
  await page.getByRole('button', { name: 'Delete reading: Original spread' }).click();

  const sibling = await context.newPage();
  await sibling.goto('/journal');
  const journal = await savedJournal(sibling);
  const replacement = { ...journal.readings[0], question: 'Replacement spread' };
  const lockName = 'arcana.guest-journal.write';
  const holder = await sibling.evaluateHandle(
    (name) =>
      new Promise<() => void>((acquired, reject) => {
        void navigator.locks.request(name, () => new Promise<void>(acquired)).catch(reject);
      }),
    lockName,
  );
  try {
    await page.getByRole('dialog').getByRole('button', { name: 'Delete Reading' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect
      .poll(() =>
        sibling.evaluate(
          async (name) =>
            (await navigator.locks.query()).pending?.some((lock) => lock.name === name),
          lockName,
        ),
      )
      .toBe(true);
    await sibling.evaluate(
      (updatedJournal) => {
        localStorage.setItem('stilllight.tarot.v1', JSON.stringify(updatedJournal));
      },
      { ...journal, readings: [replacement] },
    );
  } finally {
    await holder.evaluate((release) => release());
    await holder.dispose();
  }

  await expect(page.getByText(/This reading changed in another tab/)).toBeVisible();
  await expect(page.getByRole('heading', { name: replacement.question })).toBeVisible();
  expect((await savedJournal(page)).readings).toEqual([replacement]);
});
