import type { ReactNode } from 'react';
import { connection } from 'next/server';
import Journal from '@/features/Journal/Journal';

const JournalLayout = async ({ children }: { children: ReactNode }) => {
  await connection();
  return <Journal>{children}</Journal>;
};

export default JournalLayout;
