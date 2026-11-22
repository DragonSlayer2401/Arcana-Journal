import { expect, type Page } from '@playwright/test';

export const desktopViewports = [
  { width: 1659, height: 907 },
  { width: 1210, height: 687 },
];

export const expectPageToFit = async (page: Page) => {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const { scrollHeight, clientHeight, scrollWidth, clientWidth } = document.documentElement;
        return { horizontal: scrollWidth - clientWidth, vertical: scrollHeight - clientHeight };
      }),
    )
    .toEqual({ horizontal: 0, vertical: 0 });
  await expect(page.getByRole('banner')).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('main')).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('contentinfo')).toBeInViewport({ ratio: 1 });
};
