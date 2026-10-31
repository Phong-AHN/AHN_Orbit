'use client';

import * as React from 'react';

/**
 * A card the person may hide in this browser — the first-run steps of the
 * getting-started guide, once the agency can already publish. Only "hidden"
 * is remembered, locally; the guide itself is still derived from the data.
 */
export function HideWhenDismissed({
  storageKey,
  children,
}: {
  storageKey: string;
  children: React.ReactNode;
}) {
  const [hidden, setHidden] = React.useState(false);

  React.useEffect(() => {
    try {
      setHidden(window.localStorage.getItem(storageKey) === 'hidden');
    } catch {
      // Storage blocked: the guide simply stays.
    }
  }, [storageKey]);

  if (hidden) return null;

  return (
    <div className="relative">
      {children}
      <button
        type="button"
        onClick={() => {
          setHidden(true);
          try {
            window.localStorage.setItem(storageKey, 'hidden');
          } catch {
            // Hidden for this visit only.
          }
        }}
        className="absolute right-4 top-3 rounded px-2 py-1 text-xs text-ink-muted hover:bg-surface-sunken hover:text-ink"
      >
        Hide
      </button>
    </div>
  );
}
