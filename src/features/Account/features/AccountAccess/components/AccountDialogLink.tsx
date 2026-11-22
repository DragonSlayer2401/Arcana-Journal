'use client';

import Link from 'next/link';
import { useContext, useRef, type ReactNode } from 'react';
import { AccountDialogNavigation, type AccountPath } from '../hooks/useAccountDialog';

interface Props {
  href: AccountPath;
  className?: string;
  children: ReactNode;
}

export const AccountDialogLink = ({ href, ...props }: Props) => {
  const navigate = useContext(AccountDialogNavigation);
  const link = useRef<HTMLAnchorElement>(null);
  return (
    <Link
      {...props}
      ref={link}
      href={href}
      prefetch={false}
      onNavigate={(event) => {
        if (!navigate || !link.current) return;
        event.preventDefault();
        navigate(href, link.current);
      }}
    />
  );
};
