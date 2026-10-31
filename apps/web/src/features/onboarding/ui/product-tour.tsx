'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@orbit/ui';
import {
  TOUR_STEPS,
  placeTooltip,
  spotlightRect,
  tourStorageKey,
  type Position,
  type Rect,
  type TourStep,
} from '../tour';

/**
 * The onboarding product tour: a dimmed page with a spotlight on one part of
 * the app at a time, a tooltip explaining it, and Previous / Next / Skip.
 *
 * - Starts by itself the first time a person opens an organization in this
 *   browser, and again whenever they press the ? button beside the bell.
 * - Steps whose target is not on the page for this person (their role has no
 *   Approvals, say) are left out, and the count says so honestly.
 * - Keyboard: → next, ← previous, Esc skips; focus stays in the tooltip while
 *   it is open and returns where it was when it closes.
 * - The page underneath cannot be clicked while the tour is open, so a stray
 *   click cannot navigate away mid-step.
 *
 * Only "seen" is remembered, in this browser. Nothing is sent anywhere.
 */

function readSeen(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === 'done';
  } catch {
    return false;
  }
}

function markSeen(key: string) {
  try {
    window.localStorage.setItem(key, 'done');
  } catch {
    // Storage blocked: the tour may simply start again next time.
  }
}

function findTarget(step: TourStep): HTMLElement | null {
  for (const selector of step.targets ?? []) {
    for (const element of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      const box = element.getBoundingClientRect();
      if (box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden') {
        return element;
      }
    }
  }
  return null;
}

function toRect(element: HTMLElement): Rect {
  const box = element.getBoundingClientRect();
  return { top: box.top, left: box.left, width: box.width, height: box.height };
}

const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function ProductTour({ orgSlug }: { orgSlug: string }) {
  const storageKey = tourStorageKey(orgSlug);
  const [steps, setSteps] = React.useState<TourStep[] | null>(null);
  const [index, setIndex] = React.useState(0);
  const [target, setTarget] = React.useState<Rect | null>(null);
  const [position, setPosition] = React.useState<Position | null>(null);
  const card = React.useRef<HTMLDivElement>(null);
  const next = React.useRef<HTMLButtonElement>(null);
  const returnFocus = React.useRef<HTMLElement | null>(null);
  const titleId = React.useId();
  const bodyId = React.useId();

  const open = steps !== null;
  const step = steps?.[index];

  const start = React.useCallback(() => {
    returnFocus.current = document.activeElement as HTMLElement | null;
    // Snapshot of what this person can actually see right now.
    setSteps(TOUR_STEPS.filter((s) => !s.targets || findTarget(s)));
    setIndex(0);
  }, []);

  const close = React.useCallback(() => {
    markSeen(storageKey);
    setSteps(null);
    setTarget(null);
    setPosition(null);
    returnFocus.current?.focus?.();
  }, [storageKey]);

  // First visit to this organization in this browser: start after the page settles.
  React.useEffect(() => {
    if (readSeen(storageKey)) return;
    const timer = window.setTimeout(start, 900);
    return () => window.clearTimeout(timer);
  }, [start, storageKey]);

  // Measure the target: scroll it into view, then follow scrolling and resizing.
  React.useLayoutEffect(() => {
    if (!step) return;
    const element = findTarget(step);
    if (!element) {
      setTarget(null);
      return;
    }
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setTarget(toRect(element)));
    };
    setTarget(toRect(element));
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [step]);

  // Place the tooltip once its own size is known, before the browser paints.
  React.useLayoutEffect(() => {
    if (!step || !card.current) return;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    setPosition(
      placeTooltip(
        target,
        { width: card.current.offsetWidth, height: card.current.offsetHeight },
        viewport,
      ),
    );
  }, [step, target]);

  // Focus the main button on every step, so Enter moves on.
  React.useEffect(() => {
    if (open) next.current?.focus();
  }, [open, index]);

  const go = React.useCallback(
    (delta: number) => {
      if (!steps) return;
      const to = index + delta;
      if (to >= steps.length) close();
      else if (to >= 0) setIndex(to);
    },
    [close, index, steps],
  );

  // Keyboard: arrows move, Esc skips, Tab stays inside the tooltip.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        go(1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        go(-1);
      } else if (event.key === 'Tab' && card.current) {
        const focusable = Array.from(card.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        const first = focusable[0];
        const last = focusable.at(-1);
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        } else if (!card.current.contains(document.activeElement)) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, go, open]);

  const launcher = (
    <button
      type="button"
      onClick={start}
      aria-label="Take the product tour"
      title="Take the product tour"
      className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-line text-sm font-semibold text-ink-secondary hover:bg-surface-sunken hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      ?
    </button>
  );

  if (!open || !step || !steps) return launcher;

  const viewport =
    typeof window === 'undefined'
      ? { width: 0, height: 0 }
      : { width: window.innerWidth, height: window.innerHeight };
  const hole = target ? spotlightRect(target, viewport) : null;
  const last = index === steps.length - 1;

  return (
    <>
      {launcher}
      {createPortal(
        <div className="fixed inset-0 z-[60]" data-product-tour>
          {/* Blocks the page underneath; the dimming comes from the spotlight's shadow. */}
          <div
            aria-hidden
            className="absolute inset-0"
            style={hole ? undefined : { background: 'rgb(0 0 0 / 0.55)' }}
          />
          {hole ? (
            <div
              aria-hidden
              className="pointer-events-none absolute rounded-lg ring-2 ring-accent motion-safe:transition-all motion-safe:duration-300 motion-safe:ease-out"
              style={{
                top: hole.top,
                left: hole.left,
                width: hole.width,
                height: hole.height,
                boxShadow: '0 0 0 9999px rgb(0 0 0 / 0.55)',
              }}
            />
          ) : null}

          <div
            ref={card}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={bodyId}
            className="absolute w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-5 shadow-xl motion-safe:transition-[top,left] motion-safe:duration-300 motion-safe:ease-out"
            style={
              position
                ? { top: position.top, left: position.left }
                : { top: 0, left: 0, visibility: 'hidden' }
            }
          >
            <p className="font-mono text-xs text-accent" aria-live="polite">
              {index + 1} / {steps.length}
            </p>
            <h2 id={titleId} className="mt-1 text-base font-semibold text-ink">
              {step.title}
            </h2>
            <p id={bodyId} className="mt-2 text-sm leading-relaxed text-ink-secondary">
              {step.body}
            </p>

            <div className="mt-4 flex items-center gap-1.5" aria-hidden>
              {steps.map((s, i) => (
                <span
                  key={s.id}
                  className={`h-1.5 rounded-full motion-safe:transition-all ${i === index ? 'w-5 bg-accent' : 'w-1.5 bg-line-strong'}`}
                />
              ))}
            </div>

            <div className="mt-4 flex items-center gap-2">
              {!last ? (
                <button
                  type="button"
                  onClick={close}
                  className="mr-auto rounded px-1 text-sm text-ink-muted hover:text-ink hover:underline"
                >
                  Skip tour
                </button>
              ) : (
                <span className="mr-auto" />
              )}
              <Button variant="secondary" size="sm" onClick={() => go(-1)} disabled={index === 0}>
                Previous
              </Button>
              <Button ref={next} size="sm" onClick={() => go(1)}>
                {last ? 'Finish' : 'Next'}
              </Button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
