'use client';

import * as React from 'react';
import { cn } from '../lib/cn';

/**
 * Transient feedback (SRS §29).
 *
 * For confirmations of things that *worked* — saved, scheduled, invited. A
 * toast is the wrong place for anything a person must act on: it disappears,
 * and an error that vanishes before it is read is an error nobody handled.
 * Errors belong in the surface that caused them, next to the control that
 * failed, which is why `ErrorState` and inline `role="alert"` messages exist.
 *
 * The region is a live one, so a screen reader announces a toast without the
 * focus moving — a toast that stole focus would interrupt whatever the person
 * was typing when it arrived.
 */

export type ToastTone = 'success' | 'info' | 'warning' | 'danger';

export interface Toast {
  id: string;
  message: string;
  tone: ToastTone;
}

interface ToastContextValue {
  show: (message: string, tone?: ToastTone) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

/** How long a toast stays. Long enough to read twice, short enough to ignore. */
const DISMISS_MS = 5_000;

const TONES: Record<ToastTone, string> = {
  success: 'border-success/30 bg-success-soft text-success',
  info: 'border-info/30 bg-info-soft text-info',
  warning: 'border-warning/30 bg-warning-soft text-warning',
  danger: 'border-danger/30 bg-danger-soft text-danger',
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);

  const show = React.useCallback((message: string, tone: ToastTone = 'success') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((current) => [...current.slice(-2), { id, message, tone }]);

    setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, DISMISS_MS);
  }, []);

  const value = React.useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}

      <div
        // `status` rather than `alert`: polite, so it waits for a pause in
        // whatever the screen reader is already saying.
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              'pointer-events-auto flex w-full max-w-sm items-start gap-3',
              'rounded-lg border px-4 py-3 text-sm font-medium shadow-lg',
              TONES[toast.tone],
            )}
          >
            <span className="flex-1">{toast.message}</span>
            <button
              type="button"
              aria-label="Dismiss"
              className="shrink-0 rounded px-1 opacity-60 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              onClick={() => setToasts((current) => current.filter((t) => t.id !== toast.id))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * Never throws when there is no provider.
 *
 * A component that shows a toast is usually deep in a tree, and the alternative
 * — a hard failure — would mean a missing provider takes down a working page
 * over a piece of transient feedback. It no-ops instead, and the page still
 * works.
 */
export function useToast(): ToastContextValue {
  const context = React.useContext(ToastContext);
  return context ?? { show: () => undefined };
}
