'use client';

import { useState, type ReactNode } from 'react';
import { AccountEmailContext } from '../hooks/useAccountEmail';

export const AccountEmailProvider = ({ children }: { children: ReactNode }) => {
  const emailState = useState('');
  return <AccountEmailContext.Provider value={emailState}>{children}</AccountEmailContext.Provider>;
};
