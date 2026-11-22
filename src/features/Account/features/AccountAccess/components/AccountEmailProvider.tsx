'use client';

import { useState, type ReactNode } from 'react';
import { AccountEmailContext } from '../hooks/useAccountEmail';

export const AccountEmailProvider = ({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) => {
  const emailState = useState('');
  const [email, setEmail] = emailState;
  if (!active && email) setEmail('');
  return <AccountEmailContext.Provider value={emailState}>{children}</AccountEmailContext.Provider>;
};
