'use client';

import { createContext, useContext } from 'react';
import type { useJournalController } from './useJournalController';

export const JournalContext = createContext<ReturnType<typeof useJournalController> | null>(null);
export const useJournalSession = () => {
  const session = useContext(JournalContext);
  if (!session) throw new Error('Missing journal session.');
  return session;
};
