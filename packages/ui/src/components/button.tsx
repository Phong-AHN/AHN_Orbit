import * as React from 'react';
import { cn } from '../lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-accent-ink hover:bg-accent-hover disabled:bg-line-strong disabled:text-ink-muted',
  secondary:
    'bg-surface text-ink border border-line-strong hover:bg-surface-sunken disabled:text-ink-muted',
  ghost: 'text-ink-secondary hover:bg-surface-sunken hover:text-ink disabled:text-ink-muted',
  danger: 'bg-danger text-white hover:opacity-90 disabled:bg-line-strong disabled:text-ink-muted',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm gap-1.5',
  md: 'h-9 px-4 text-sm gap-2',
  lg: 'h-11 px-6 text-base gap-2',
};

/**
 * The button's appearance, without the `<button>`.
 *
 * A link that looks like a button must *be* a link. Wrapping `<Button>` in an
 * anchor produces `<a><button></a>`, which the HTML spec forbids — interactive
 * content cannot nest — and browsers do not run the anchor's activation
 * behaviour when the click starts on the inner control. The result is a control
 * that looks perfectly normal and does nothing at all.
 *
 * So navigation uses `<Link className={buttonClassName()}>`: one element, one
 * role, and middle-click and the context menu work as they should.
 */
export function buttonClassName(
  options: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {},
): string {
  const { variant = 'primary', size = 'md', className } = options;

  return cn(
    'inline-flex items-center justify-center rounded font-medium transition-colors',
    'disabled:cursor-not-allowed',
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and disables the control. Prefer this over managing both. */
  loading?: boolean;
  /** Announced to assistive tech while loading. */
  loadingLabel?: string;
}

/**
 * The product's only button.
 *
 * `loading` disables the control as well as showing the spinner, because a
 * button that looks busy but still fires is how double-publishes start.
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant = 'primary',
    size = 'md',
    loading = false,
    loadingLabel = 'Working…',
    disabled,
    children,
    type = 'button',
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClassName({ variant, size, className })}
      {...props}
    >
      {loading ? (
        <>
          <Spinner className="size-4" />
          <span>{loadingLabel}</span>
        </>
      ) : (
        children
      )}
    </button>
  );
});

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn('animate-spin', className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
