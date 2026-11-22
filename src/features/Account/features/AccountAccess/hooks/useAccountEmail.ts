'use client';

import { createContext, useContext } from 'react';

export const AccountEmailContext = createContext<[string, (email: string) => void] | null>(null);

export const useAccountEmail = () => {
  const emailState = useContext(AccountEmailContext);
  if (!emailState) throw new Error('Account fields require an account email provider.');
  return emailState;
};
