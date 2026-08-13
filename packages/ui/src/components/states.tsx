import * as React from 'react';
import { cn } from '../lib/cn';
import { Button } from './button';

/**
 * The required UI states (SRS §29, §41).
 *
 * These are components rather than ad-hoc markup so that "does this feature
 * have an empty state?" is answerable by grep, and so a feature PR missing one
 * is visible in review. A feature is not done without them.
 */

// ── Loading ─────────────────────────────────────────────────────────────────

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn('animate-pulse rounded bg-surface-sunken', className)} aria-hidden="true" />
  );
}

export interface LoadingProps {
  /** Describes what is loading, for screen readers. */
  label?: string;
  rows?: number;
  className?: string;
}

export function Loading({ label = 'Loading…', rows = 3, className }: LoadingProps) {
  return (
    <div className={cn('space-y-3', className)} role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn('h-12 w-full', i === rows - 1 && 'w-2/3')} />
      ))}
    </div>
  );
}

// ── Shared shell for the message states ─────────────────────────────────────

interface MessageStateProps {
  icon: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  tone?: 'neutral' | 'danger' | 'warning';
  className?: string;
}

const TONE_RING: Record<NonNullable<MessageStateProps['tone']>, string> = {
  neutral: 'bg-surface-sunken text-ink-muted',
  danger: 'bg-danger-soft text-danger',
  warning: 'bg-warning-soft text-warning',
};

function MessageState({
  icon,
  title,
  description,
  action,
  tone = 'neutral',
  className,
}: MessageStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border border-line',
        'bg-surface px-6 py-12 text-center',
        className,
      )}
    >
      <div className={cn('mb-4 grid size-11 place-items-center rounded-full', TONE_RING[tone])}>
        {icon}
      </div>
      <p className="text-base font-semibold text-ink">{title}</p>
      {description ? (
        <p className="mt-1.5 max-w-prose text-sm text-ink-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

// ── Empty ───────────────────────────────────────────────────────────────────

export interface EmptyProps {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}

export function Empty({ title, description, action, icon, className }: EmptyProps) {
  return (
    <MessageState
      icon={icon ?? <IconInbox />}
      title={title}
      description={description}
      action={action}
      className={className}
    />
  );
}

// ── Error ───────────────────────────────────────────────────────────────────

export interface ErrorStateProps {
  /** Safe, human-readable text. Never a raw exception message (SRS §37). */
  title?: string;
  description?: React.ReactNode;
  /** Shown in small print so a user can quote it to support. */
  correlationId?: string;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}

export function ErrorState({
  title = 'Something went wrong',
  description = 'The action could not be completed. Try again in a moment.',
  correlationId,
  onRetry,
  retryLabel = 'Try again',
  className,
}: ErrorStateProps) {
  return (
    <div role="alert">
      <MessageState
        icon={<IconAlert />}
        tone="danger"
        title={title}
        description={
          <>
            {description}
            {correlationId ? (
              <span className="mt-2 block font-mono text-xs text-ink-muted">
                Reference: {correlationId}
              </span>
            ) : null}
          </>
        }
        action={
          onRetry ? (
            <Button variant="secondary" onClick={onRetry}>
              {retryLabel}
            </Button>
          ) : null
        }
        className={className}
      />
    </div>
  );
}

// ── Permission denied ───────────────────────────────────────────────────────

export interface PermissionDeniedProps {
  /** What was being attempted, in the user's language — not a permission slug. */
  action?: string;
  description?: React.ReactNode;
  className?: string;
}

/**
 * Rendered when the server refused. The frontend's own permission checks only
 * hide controls; they are never the decision (docs/RBAC.md §6).
 */
export function PermissionDenied({ action, description, className }: PermissionDeniedProps) {
  return (
    <MessageState
      icon={<IconLock />}
      tone="warning"
      title={action ? `You can't ${action}` : "You don't have access to this"}
      description={
        description ?? 'Ask an organization admin if you need access to this part of the workspace.'
      }
      className={className}
    />
  );
}

// ── Offline ─────────────────────────────────────────────────────────────────

export function Offline({ className }: { className?: string }) {
  return (
    <div role="alert">
      <MessageState
        icon={<IconOffline />}
        tone="warning"
        title="You're offline"
        description="Changes you make now won't be saved until the connection comes back."
        className={className}
      />
    </div>
  );
}

// ── Icons ───────────────────────────────────────────────────────────────────
// Inline so the design system has no icon-font or CDN dependency.

const iconProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  className: 'size-5',
  'aria-hidden': true,
};

function IconInbox() {
  return (
    <svg {...iconProps}>
      <path d="M3 12h4l2 3h6l2-3h4" />
      <path d="M5 5h14l2 7v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z" />
    </svg>
  );
}

function IconAlert() {
  return (
    <svg {...iconProps}>
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.3 4.3 2.6 17.6A2 2 0 0 0 4.3 20.6h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z" />
    </svg>
  );
}

function IconLock() {
  return (
    <svg {...iconProps}>
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function IconOffline() {
  return (
    <svg {...iconProps}>
      <path d="m2 2 20 20" />
      <path d="M8.5 16.4a5 5 0 0 1 7 0" />
      <path d="M5 13a10 10 0 0 1 3.2-2.1" />
      <path d="M15.8 10.9A10 10 0 0 1 19 13" />
      <path d="M2 9a15 15 0 0 1 4.5-2.8" />
      <path d="M12 6a15 15 0 0 1 10 3" />
      <path d="M12 20h.01" />
    </svg>
  );
}
