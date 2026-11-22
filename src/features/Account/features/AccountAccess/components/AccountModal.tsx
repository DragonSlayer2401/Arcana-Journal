'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import Modal from 'react-bootstrap/Modal';
import { Icon } from '@/components/Icon';

interface AccountModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export const AccountModal = ({ title, onClose, children }: AccountModalProps) => {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const previousTitle = document.title;
    const dialogTitle = `Arcana Journal · ${title}`;
    document.title = dialogTitle;
    heading.current?.focus();
    return () => {
      if (document.title === dialogTitle) document.title = previousTitle;
    };
  }, [title]);

  return (
    <Modal
      show
      onHide={onClose}
      bsPrefix="auth-modal"
      dialogClassName="auth-modal-dialog"
      contentClassName="auth-modal-content"
      animation={false}
      aria-labelledby="auth-title"
      restoreFocusOptions={{ preventScroll: true }}
    >
      <div className="auth-modal-heading">
        <h1 id="auth-title" ref={heading} tabIndex={-1}>
          {title}
        </h1>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close dialog">
          <Icon name="close" />
        </button>
      </div>
      {children}
    </Modal>
  );
};
