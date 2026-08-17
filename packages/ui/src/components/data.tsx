import * as React from 'react';
import { cn } from '../lib/cn';

/**
 * Data-display primitives: tables, stats, alerts, breadcrumbs, tabs (SRS §29).
 *
 * These exist because the alternative is every page inventing its own — which
 * is what "the UI looks basic" actually means in practice: not that any one
 * page is wrong, but that ten pages each solved the same problem slightly
 * differently.
 */

// ── Table ───────────────────────────────────────────────────────────────────

/**
 * A table that survives a narrow screen.
 *
 * The wrapper scrolls horizontally rather than the page doing it, so a wide
 * table never makes the whole layout slide. Hiding columns on mobile is the
 * other option and it is worse: the columns you drop are always the ones
 * somebody needed.
 */
export function Table({
  className,
  caption,
  ...props
}: React.TableHTMLAttributes<HTMLTableElement> & { caption?: string }) {
  return (
    <div className="w-full overflow-x-auto rounded-lg border border-line">
      <table className={cn('w-full border-collapse text-sm', className)} {...props}>
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        {props.children}
      </table>
    </div>
  );
}

export function THead({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn('bg-surface-sunken', className)} {...props} />;
}

export function TH({
  className,
  align = 'left',
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      className={cn(
        'whitespace-nowrap px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-ink-muted',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        align === 'left' && 'text-left',
        className,
      )}
      {...props}
    />
  );
}

export function TBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn('divide-y divide-line', className)} {...props} />;
}

export function TR({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('bg-surface hover:bg-surface-sunken/60', className)} {...props} />;
}

export function TD({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-4 py-2.5 align-middle text-ink-secondary', className)} {...props} />;
}

// ── Stat ────────────────────────────────────────────────────────────────────

export interface StatProps {
  label: string;
  value: React.ReactNode;
  /** Context under the number: a comparison, a period, a caveat. */
  hint?: React.ReactNode;
  /** Colours the value. Reserve for numbers that genuinely carry a verdict. */
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
  /** Makes the whole tile a link. A stat you cannot act on is decoration. */
  href?: string;
}

const STAT_TONES: Record<NonNullable<StatProps['tone']>, string> = {
  neutral: 'text-ink',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
};

/**
 * One number, with the context that makes it mean something.
 *
 * `hint` is not optional decoration — a bare "3" tells a person nothing, and
 * every stat in this product either says what the number is measuring over or
 * links somewhere the person can act on it.
 */
export function Stat({ label, value, hint, tone = 'neutral', href }: StatProps) {
  const body = (
    <>
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className={cn('mt-1 text-2xl font-semibold tabular-nums', STAT_TONES[tone])}>{value}</dd>
      {hint ? <p className="mt-1 text-xs text-ink-muted">{hint}</p> : null}
    </>
  );

  const shell = 'rounded-lg border border-line bg-surface px-4 py-3 shadow-sm';

  if (href) {
    return (
      <a
        href={href}
        className={cn(
          shell,
          'block transition-colors hover:border-line-strong hover:bg-surface-sunken/50',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        )}
      >
        <dl>{body}</dl>
      </a>
    );
  }

  return (
    <div className={shell}>
      <dl>{body}</dl>
    </div>
  );
}

export function StatGrid({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4', className)}
      {...props}
    />
  );
}

// ── Alert ───────────────────────────────────────────────────────────────────

export type AlertTone = 'info' | 'success' | 'warning' | 'danger';

const ALERT_TONES: Record<AlertTone, string> = {
  info: 'border-info/30 bg-info-soft text-info',
  success: 'border-success/30 bg-success-soft text-success',
  warning: 'border-warning/30 bg-warning-soft text-warning',
  danger: 'border-danger/30 bg-danger-soft text-danger',
};

/**
 * A persistent message about the state of the page.
 *
 * Unlike a toast, it stays — which is what makes it the right home for
 * anything the person has to do something about. `warning` and `danger`
 * announce themselves; `info` and `success` do not interrupt.
 */
export function Alert({
  tone = 'info',
  title,
  children,
  actions,
  className,
}: {
  tone?: AlertTone;
  title?: string;
  children?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
      className={cn('rounded-lg border px-4 py-3 text-sm', ALERT_TONES[tone], className)}
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          {title ? <p className="font-semibold">{title}</p> : null}
          {children ? <div className={cn(title && 'mt-0.5')}>{children}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

// ── Breadcrumbs ─────────────────────────────────────────────────────────────

export interface Crumb {
  label: string;
  href?: string;
}

/**
 * Where you are, and how to get back up.
 *
 * The last crumb is the current page and is not a link — it carries
 * `aria-current` instead, so a screen reader announces the position rather than
 * offering a link to where the user already is.
 */
export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={cn('min-w-0', className)}>
      <ol className="flex flex-wrap items-center gap-1 text-xs text-ink-muted">
        {items.map((item, index) => {
          const last = index === items.length - 1;

          return (
            <li key={`${item.label}-${index}`} className="flex min-w-0 items-center gap-1">
              {item.href && !last ? (
                <a
                  href={item.href}
                  className="truncate rounded hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  {item.label}
                </a>
              ) : (
                <span
                  className="truncate text-ink-secondary"
                  aria-current={last ? 'page' : undefined}
                >
                  {item.label}
                </span>
              )}
              {!last ? (
                <span aria-hidden="true" className="text-line-strong">
                  /
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ── Section ─────────────────────────────────────────────────────────────────

/**
 * A titled block of a page.
 *
 * Exists so a heading and its content are associated for assistive tech
 * without every page remembering to wire `aria-labelledby` by hand — which, in
 * practice, half of them forget.
 */
export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const id = React.useId();

  return (
    <section aria-labelledby={id} className={cn('space-y-3', className)}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 id={id} className="text-sm font-semibold tracking-tight text-ink">
            {title}
          </h2>
          {description ? <p className="mt-0.5 text-sm text-ink-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
      </div>

      {children}
    </section>
  );
}
