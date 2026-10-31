/**
 * The product tour (onboarding): which steps, and where the tooltip goes.
 *
 * Kept free of React and the DOM so it can be tested exactly. A step names
 * its target by CSS selectors, tried in order — the docked rail on a desktop,
 * the Menu button on a phone — and a step whose target is not on the page for
 * this person (their role has no Approvals, say) is skipped rather than
 * pointing at nothing.
 */

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** Selectors tried in order; the first visible match is highlighted. None: a centred card. */
  targets?: readonly string[];
}

export const TOUR_VERSION = 1;

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to Social Square',
    body: 'A one-minute tour of where things are. Use the buttons or the arrow keys, and press Esc to leave at any time.',
  },
  {
    id: 'navigation',
    title: 'Everything is here',
    body: 'Your work for every client — posts, ideas, calendar, approvals, inbox and analytics. You see exactly what your role allows.',
    targets: ['[data-tour="rail"]', '[data-tour="menu"]'],
  },
  {
    id: 'create',
    title: 'Start here',
    body: 'Create a post for any brand: write it once, tailor it for each platform, and send it for approval.',
    targets: ['[data-tour="primary-action"]'],
  },
  {
    id: 'calendar',
    title: 'See the plan',
    body: 'The calendar shows what is scheduled and what has gone out, for each client and account.',
    targets: ['nav a[href$="/calendar"]'],
  },
  {
    id: 'approvals',
    title: 'Approvals',
    body: 'Posts waiting for a decision from your team or your client.',
    targets: ['nav a[href$="/approvals"]'],
  },
  {
    id: 'community',
    title: 'Comments and messages',
    body: 'Answer your audience’s comments and private messages from one inbox.',
    targets: ['nav a[href$="/community"]'],
  },
  {
    id: 'analytics',
    title: 'Results',
    body: 'Performance for every post and account, compared over time, with client-ready reports.',
    targets: ['nav a[href$="/analytics"]'],
  },
  {
    id: 'notifications',
    title: 'Stay in the loop',
    body: 'Approvals, failed posts and new messages arrive here.',
    targets: ['[data-tour="notifications"]'],
  },
  {
    id: 'squire',
    title: 'Meet Squire',
    body: 'Ask in plain language to plan, write, create images or check results. Anything that goes out waits for your confirmation.',
    targets: ['[data-tour="squire"]'],
  },
  {
    id: 'done',
    title: 'You’re all set',
    body: 'Take this tour again any time with the ? button at the top of the page.',
  },
];

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export type Placement = 'bottom' | 'top' | 'right' | 'left' | 'center';

export interface Position {
  top: number;
  left: number;
  placement: Placement;
}

/** Space kept between the spotlight and the tooltip, and from the window's edges. */
export const GAP = 12;
export const EDGE = 16;
/** Padding around the highlighted element, so the spotlight does not clip it. */
export const SPOTLIGHT_PADDING = 6;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

/**
 * Where the tooltip goes: below the target if it fits, else above, to the
 * right, to the left — and always inside the window. With no target, centred.
 */
export function placeTooltip(
  target: Rect | null,
  tooltip: { width: number; height: number },
  viewport: { width: number; height: number },
): Position {
  if (!target) {
    return {
      top: Math.max(EDGE, (viewport.height - tooltip.height) / 2),
      left: Math.max(EDGE, (viewport.width - tooltip.width) / 2),
      placement: 'center',
    };
  }

  const fitsBelow = target.top + target.height + GAP + tooltip.height <= viewport.height - EDGE;
  const fitsAbove = target.top - GAP - tooltip.height >= EDGE;
  const fitsRight = target.left + target.width + GAP + tooltip.width <= viewport.width - EDGE;
  const fitsLeft = target.left - GAP - tooltip.width >= EDGE;

  const centredLeft = clamp(
    target.left + target.width / 2 - tooltip.width / 2,
    EDGE,
    viewport.width - EDGE - tooltip.width,
  );
  const centredTop = clamp(
    target.top + target.height / 2 - tooltip.height / 2,
    EDGE,
    viewport.height - EDGE - tooltip.height,
  );

  // A tall target (the whole navigation rail) reads better with the card
  // beside it than squeezed above or below.
  const tall = target.height > viewport.height / 2;

  if (!tall && fitsBelow) {
    return { top: target.top + target.height + GAP, left: centredLeft, placement: 'bottom' };
  }
  if (!tall && fitsAbove) {
    return { top: target.top - GAP - tooltip.height, left: centredLeft, placement: 'top' };
  }
  if (fitsRight) {
    return { top: centredTop, left: target.left + target.width + GAP, placement: 'right' };
  }
  if (fitsLeft) {
    return { top: centredTop, left: target.left - GAP - tooltip.width, placement: 'left' };
  }
  // Nowhere fits cleanly (a small phone): keep it on screen, near the bottom.
  return {
    top: clamp(viewport.height - EDGE - tooltip.height, EDGE, viewport.height),
    left: clamp((viewport.width - tooltip.width) / 2, EDGE, viewport.width),
    placement: 'center',
  };
}

/** The spotlight rectangle: the target, padded, kept inside the window. */
export function spotlightRect(target: Rect, viewport: { width: number; height: number }): Rect {
  const top = Math.max(0, target.top - SPOTLIGHT_PADDING);
  const left = Math.max(0, target.left - SPOTLIGHT_PADDING);
  const bottom = Math.min(viewport.height, target.top + target.height + SPOTLIGHT_PADDING);
  const right = Math.min(viewport.width, target.left + target.width + SPOTLIGHT_PADDING);
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export const tourStorageKey = (orgSlug: string) => `social-square:tour:v${TOUR_VERSION}:${orgSlug}`;
