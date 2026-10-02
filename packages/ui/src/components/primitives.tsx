import * as React from 'react';
import { cn } from '../lib/cn';

// ── Card ────────────────────────────────────────────────────────────────────

/**
 * A panel.
 *
 * No shadow: this design separates things with rules and whitespace, and a
 * soft grey shadow under every card is what makes a page read as a kit of
 * identical boxes. The radius is the middle step of the scale — inputs sit
 * tighter, only overlays sit looser — so the radius itself says what kind of
 * surface this is.
 */
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded border border-line bg-surface', className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('border-b border-line px-5 py-4', className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn('font-display text-display-sm font-semibold text-ink', className)}
      {...props}
    />
  );
}

export function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 py-4', className)} {...props} />;
}

// ── Badge ───────────────────────────────────────────────────────────────────

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-sunken text-ink-secondary border-line-strong',
  accent: 'bg-accent-soft text-accent border-accent/30',
  success: 'bg-success-soft text-success border-success/30',
  warning: 'bg-warning-soft text-warning border-warning/30',
  danger: 'bg-danger-soft text-danger border-danger/30',
  info: 'bg-info-soft text-info border-info/30',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

/**
 * State is encoded in form as well as colour — the label always carries the
 * meaning, so the badge stays readable without colour perception.
 */
export function Badge({ className, tone = 'neutral', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm border px-2 py-0.5',
        'text-xs font-medium',
        BADGE_TONES[tone],
        className,
      )}
      {...props}
    />
  );
}

// ── Form field ──────────────────────────────────────────────────────────────

export interface FieldProps {
  label: string;
  htmlFor: string;
  hint?: React.ReactNode;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}

/**
 * Wraps a control with its label, hint, and error, wiring `aria-describedby`
 * and `aria-invalid` so the association is real rather than visual (SRS §29).
 */
export function Field({ label, htmlFor, hint, error, required, children, className }: FieldProps) {
  const hintId = hint ? `${htmlFor}-hint` : undefined;
  const errorId = error ? `${htmlFor}-error` : undefined;

  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-ink">
        {label}
        {required ? (
          <span className="ml-0.5 text-danger" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>

      {React.isValidElement(children)
        ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
            'aria-describedby': [hintId, errorId].filter(Boolean).join(' ') || undefined,
            'aria-invalid': error ? true : undefined,
            'aria-required': required || undefined,
          })
        : children}

      {hint && !error ? (
        <p id={hintId} className="text-xs text-ink-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-9 w-full rounded-sm border border-line-strong bg-surface px-3 text-sm text-ink',
        'placeholder:text-ink-muted',
        'aria-[invalid=true]:border-danger',
        'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-ink-muted',
        className,
      )}
      {...props}
    />
  );
});

/**
 * The native control, deliberately.
 *
 * Every select this product needs picks from a short, known list — a workspace,
 * a brand, a time zone. A custom listbox would have to re-earn keyboard
 * handling, screen-reader semantics and the mobile picker that the platform
 * already gets right, and would still be worse on a phone.
 */
export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, ...props }, ref) {
  return (
    <select
      ref={ref}
      className={cn(
        'h-9 w-full rounded-sm border border-line-strong bg-surface px-2.5 text-sm text-ink',
        'aria-[invalid=true]:border-danger',
        'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-ink-muted',
        className,
      )}
      {...props}
    />
  );
});

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        'w-full rounded-sm border border-line-strong bg-surface px-3 py-2 text-sm text-ink',
        'placeholder:text-ink-muted',
        'aria-[invalid=true]:border-danger',
        'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-ink-muted',
        className,
      )}
      {...props}
    />
  );
});

// ── Page furniture ──────────────────────────────────────────────────────────

export interface PageHeaderProps {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  eyebrow?: React.ReactNode;
}

/**
 * The masthead, and the one place this design raises its voice.
 *
 * Everything else on a screen stays quiet — no shadows, few boxes — so the
 * page's own name can be set large in the display face above a single rule.
 * That rule is the whole device: it does the job a row of bordered cards was
 * doing, with one line.
 *
 * The eyebrow is a **dateline**: sentence case, in the body face, at reading
 * weight. It used to be tracked-out monospace capitals, which is three
 * generated-page habits in one line — a monospace face standing in for
 * "data", capitals standing in for "label", and letter-spacing standing in
 * for care. It says which client and which day; it does not need to shout.
 */
export function PageHeader({ title, description, actions, eyebrow }: PageHeaderProps) {
  return (
    <header className="mb-6 border-b border-line pb-4">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          {eyebrow ? <p className="mb-1.5 text-sm text-ink-muted">{eyebrow}</p> : null}
          <h1 className="font-display text-display font-semibold text-ink">{title}</h1>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {description ? (
        <p className="mt-3 max-w-measure text-sm text-ink-secondary">{description}</p>
      ) : null}
    </header>
  );
}

/** Wide content scrolls inside its own container so the page never scrolls sideways. */
export function Scroller({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('overflow-x-auto rounded border border-line bg-surface', className)}
      {...props}
    />
  );
}
