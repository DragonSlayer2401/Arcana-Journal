import { useState } from 'react';
import { Modal } from '@/components/Modal';
import { Icon } from '@/components/Icon';
import type { Reading } from '@/features/Journal/readingTypes';
import { sameReadingContent } from '@/features/Journal/utils/readingIdentity';
import { formatReading } from '../utils/formatReading';

interface CopyAttempt {
  reading: Reading;
  text: string;
  status: 'pending' | 'copied' | 'manual';
}

export const ShareReading = ({ reading }: { reading: Reading }) => {
  const [copy, setCopy] = useState<CopyAttempt | null>(null);
  if (copy && !sameReadingContent(copy.reading, reading)) setCopy(null);

  const copyReading = async () => {
    const attempt: CopyAttempt = { reading, text: formatReading(reading), status: 'pending' };
    setCopy(attempt);
    let status: 'copied' | 'manual';
    try {
      await navigator.clipboard.writeText(attempt.text);
      status = 'copied';
    } catch {
      status = 'manual';
    }
    setCopy((current) => (current === attempt ? { ...attempt, status } : current));
  };
  const copied = copy?.status === 'copied';
  return (
    <>
      <div className="reading-actions">
        <button className="button button-secondary" onClick={copyReading}>
          <Icon name={copied ? 'check' : 'copy'} />
          {copied ? 'Copied Reading' : 'Copy Reading'}
        </button>
        <span role="status">{copied && 'Ready to paste into your chat or notes.'}</span>
      </div>
      {copy?.status === 'manual' && (
        <Modal title="Copy your reading" onClose={() => setCopy(null)}>
          <p>Your browser couldn’t access the clipboard. Select and copy the text below.</p>
          <textarea
            className="copy-fallback"
            aria-label="Reading text to copy"
            readOnly
            value={copy.text}
            onFocus={(event) => event.target.select()}
            rows={12}
          />
        </Modal>
      )}
    </>
  );
};
