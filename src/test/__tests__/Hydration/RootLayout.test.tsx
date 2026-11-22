import RootLayout from '@/app/layout';
import { render } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

it('hydrates the page when Grammarly adds attributes to the body', () => {
  const onClick = vi.fn();
  const page = (
    <RootLayout>
      <button onClick={onClick}>Draw Cards</button>
    </RootLayout>
  );
  const pageDocument = new DOMParser().parseFromString(renderToString(page), 'text/html');
  const button = pageDocument.querySelector('button')!;
  pageDocument.body.setAttribute('data-gr-ext-installed', '');
  pageDocument.body.setAttribute('data-new-gr-c-s-check-loaded', '14.1349.0');

  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  const onRecoverableError = vi.fn();
  render(page, { container: pageDocument, hydrate: true, onRecoverableError });

  button.click();
  expect(onClick).toHaveBeenCalledOnce();
  expect(onRecoverableError).not.toHaveBeenCalled();
  expect(consoleError).not.toHaveBeenCalled();
});
