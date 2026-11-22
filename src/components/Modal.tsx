import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { Icon } from './Icon';

export const Modal = ({
  title,
  onClose,
  children,
  className = '',
  fallbackFocusRef,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
}) => {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previous?.isConnected) previous.focus();
      else if (document.activeElement === document.body) fallbackFocusRef?.current?.focus();
    };
  }, [fallbackFocusRef]);
  return (
    <dialog
      ref={ref}
      className={`modal ${className}`}
      aria-label={title}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="modal-inner">
        <div className="modal-heading">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close dialog">
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
};
