'use client';

import type { ReactNode } from 'react';
import { useJournalSession } from '@/features/Journal/hooks/useJournalSession';
import { Icon } from '@/components/Icon';
import { createReading, getSpreadCount } from '../utils/createReading';

const spreadOptions = [
  { mode: 'one', glyph: '▯', label: 'One card', description: 'A single focus' },
  { mode: 'three', glyph: '▯▯▯', label: 'Three cards', description: 'Room to explore' },
  { mode: 'custom', glyph: '✧', label: 'Custom', description: 'Your own spread' },
] as const;

const drawOptions = [
  { key: 'reversals', label: 'Include reversals', hint: 'Allow upright and reversed cards' },
  { key: 'instantReveal', label: 'Reveal cards instantly', hint: 'Draw your spread face up' },
] as const;

export const ReadingForm = ({ children }: { children: ReactNode }) => {
  const { draw } = useJournalSession();
  return (
    <form
      className="reading-form"
      onSubmit={(event) => {
        event.preventDefault();
        draw(createReading);
      }}
    >
      {children}
    </form>
  );
};

export const SpreadSelector = () => {
  const { opening, data, updateSettings } = useJournalSession();
  return (
    <>
      <fieldset disabled={opening}>
        <legend>Choose your spread</legend>
        <div className="mode-options">
          {spreadOptions.map(({ mode, glyph, label, description }) => (
            <button
              type="button"
              key={mode}
              aria-pressed={data.settings.mode === mode}
              className={data.settings.mode === mode ? 'mode-option selected' : 'mode-option'}
              onClick={() => updateSettings({ mode })}
            >
              <span className="mode-glyph" aria-hidden="true">
                {glyph}
              </span>
              <strong>{label}</strong>
              <small>{description}</small>
            </button>
          ))}
        </div>
      </fieldset>
      {data.settings.mode === 'custom' && (
        <label className="custom-count">
          Number of cards{' '}
          <select
            disabled={opening}
            value={data.settings.customCount}
            onChange={(event) => updateSettings({ customCount: Number(event.target.value) })}
          >
            {Array.from({ length: 10 }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                {i + 1}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  );
};

export const QuestionInput = () => {
  const { opening, question, setQuestion } = useJournalSession();
  return (
    <textarea
      disabled={opening}
      id="question"
      value={question}
      maxLength={2000}
      onChange={(event) => setQuestion(event.target.value)}
      placeholder="A question, an intention, or simply an open mind…"
      rows={3}
    />
  );
};

export const DrawControls = () => {
  const { opening, data, updateSettings } = useJournalSession();
  return (
    <>
      {drawOptions.map(({ key, label, hint }) => (
        <label key={key} className="reading-setting">
          <span>
            <strong>{label}</strong>
            <small>{hint}</small>
          </span>
          <input
            type="checkbox"
            disabled={opening}
            checked={data.settings[key]}
            onChange={(event) => updateSettings({ [key]: event.target.checked })}
          />
          <span className="switch" aria-hidden="true" />
        </label>
      ))}
      <button disabled={opening} type="submit" className="button button-gold draw-button">
        <Icon name="spark" /> Draw Cards{' '}
        <span className="button-count">{getSpreadCount(data.settings)}</span>
      </button>
    </>
  );
};

export const DrawError = () => {
  const { error } = useJournalSession();
  return error ? (
    <p className="draw-error notice warning" role="alert">
      {error}
    </p>
  ) : null;
};
