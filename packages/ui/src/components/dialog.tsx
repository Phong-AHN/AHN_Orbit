'use client';

import * as React from 'react';
import { cn } from '../lib/cn';
import { Button, type ButtonVariant } from './button';

/**
 * Modal dialogs, built on the native `<dialog>` element (SRS §29).
 *
 * The platform gives away most of what an accessible modal needs — focus trap,
 * `Escape` to close, inert background, top-layer stacking — and every one of
 * those is a thing a hand-rolled overlay gets subtly wrong. The remaining work
 * is labelling it and deciding what a backdrop click means.
 *
 * **A backdrop click closes an ordinary dialog and does nothing on a
 * destructive one.** Losing a form to a stray click is annoying; deleting a
 * client's brand to one is not, so the confirmation for anything destructive
 * has to be a deliberate press.
 */

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Sits under the title. Say what will happen, not what the button says. */
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  /** Suppresses backdrop-click dismissal. Set for anything irreversible. */
  dismissible?: boolean;
  className?: string;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  dismissible = true,
  className,
}: DialogProps) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  const descriptionId = React.useId();

  React.useEffect(() => {
    const node = ref.current;
    if (!node) return;

    // `showModal` is what puts the dialog in the top layer and makes the rest
    // of the page inert. `open={true}` as an attribute does neither.
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      {...(description ? { 'aria-describedby': descriptionId } : {})}
      // `cancel` is Escape. Routed through the same handler as everything else
      // so the caller's state cannot drift out of step with the element's.
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (!dismissible) return;
        // The dialog element fills the viewport; only a click on the element
        // itself — rather than on its contents — is a backdrop click.
        if (event.target === ref.current) onClose();
      }}
      className={cn(
        'w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-0',
        'text-ink shadow-lg backdrop:bg-ink/40 backdrop:backdrop-blur-[1px]',
        'open:animate-none',
        className,
      )}
    >
      <div className="border-b border-line px-5 py-4">
        <h2 id={titleId} className="text-sm font-semibold tracking-tight text-ink">
          {title}
        </h2>
        {description ? (
          <p id={descriptionId} className="mt-1 text-sm text-ink-secondary">
            {description}
          </p>
        ) : null}
      </div>

      {children ? <div className="px-5 py-4">{children}</div> : null}

      {footer ? (
        <div className="flex flex-wrap justify-end gap-2 border-t border-line bg-surface-sunken px-5 py-3">
          {footer}
        </div>
      ) : null}
    </dialog>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` for anything that destroys or disconnects. */
  tone?: Extract<ButtonVariant, 'primary' | 'danger'>;
  /** Extra context — what else this affects, what cannot be undone. */
  children?: React.ReactNode;
  busy?: boolean;
}

/**
 * The confirmation every destructive action goes through.
 *
 * The confirm button names the **action**, not "OK" — a person clicking
 * "Disconnect" knows what they are agreeing to in a way that "Yes" never
 * conveys. Cancel comes first in the DOM so it is the first thing reached by
 * keyboard, and it is the safe choice to land on.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  children,
  busy = false,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      // Never dismissible: a stray backdrop click must not resolve a question
      // about destroying something.
      dismissible={false}
      footer={
        <>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone}
            size="sm"
            loading={busy}
            disabled={busy}
            onClick={() => void onConfirm()}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
