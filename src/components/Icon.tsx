export const Icon = ({
  name,
  size = 20,
}: {
  name:
    | 'spark'
    | 'book'
    | 'cards'
    | 'library'
    | 'close'
    | 'copy'
    | 'check'
    | 'trash'
    | 'info'
    | 'moon';
  size?: number;
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {name === 'spark' && (
      <>
        <path d="m12 2 2.7 7.3L22 12l-7.3 2.7L12 22l-2.7-7.3L2 12l7.3-2.7Z" />
        <path d="m20 2 .5 1.5L22 4l-1.5.5L20 6l-.5-1.5L18 4l1.5-.5Z" />
      </>
    )}
    {name === 'book' && (
      <>
        <path d="M12 5v16M12 5C9 2 4 3 2 4v15c4-1 7-1 10 2 3-3 6-3 10-2V4c-2-1-7-2-10 1Z" />
      </>
    )}
    {name === 'cards' && (
      <>
        <rect x="8" y="3" width="12" height="17" rx="2" />
        <path d="m5 5-3 1 3 16 11-1M14 8l1.5 3L18 12l-2.5 1-1.5 3-1.5-3-2.5-1 2.5-1Z" />
      </>
    )}
    {name === 'library' && (
      <>
        <rect x="3" y="4" width="7" height="15" rx="1.5" />
        <rect x="13.5" y="4" width="7" height="15" rx="1.5" transform="rotate(-10 17 11.5)" />
      </>
    )}
    {name === 'close' && <path d="m6 6 12 12M18 6 6 18" />}
    {name === 'copy' && (
      <>
        <rect x="8" y="8" width="12" height="13" rx="2" />
        <path d="M16 8V3H3v13h5" />
      </>
    )}
    {name === 'check' && <path d="m5 12 4 4L19 6" />}
    {name === 'trash' && (
      <>
        <path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" />
      </>
    )}
    {name === 'info' && (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6M12 7h.01" />
      </>
    )}
    {name === 'moon' && <path d="M20 15.5A9 9 0 0 1 8.5 4 9 9 0 1 0 20 15.5Z" />}
  </svg>
);
