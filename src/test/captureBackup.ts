import { vi } from 'vitest';
import type { Reading } from '@/features/Journal/readingTypes';

export const captureBackup = () => {
  const createObjectURL = vi.fn<(_blob: Blob) => string>().mockReturnValue('blob:journal-test');
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = vi.fn();
    },
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  return () =>
    new Promise<{ version: number; readings: Reading[] }>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(JSON.parse(String(reader.result)));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(createObjectURL.mock.lastCall![0]);
    });
};
