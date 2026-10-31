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

/** Raised when the steps change in a way everybody should see again. */
export const TOUR_VERSION = 2;

/**
 * The steps follow the work in the order a new agency does it — the same
 * order as the getting-started guide on the Today page: client → brand →
 * accounts → idea → post → publish → results → comments and messages.
 */
export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to Social Square',
    body: 'This tour follows one piece of content from start to finish: set up a client and brand, connect accounts, plan, post, then read the results and answer your audience. Use the buttons or arrow keys; Esc leaves.',
  },
  {
    id: 'checklist',
    title: 'Your checklist',
    body: 'The Today page keeps these same steps as a checklist and ticks each one off as you do it, so you always know what comes next.',
    targets: ['[data-tour="setup-guide"]', 'nav a[href$="/dashboard"]'],
  },
  {
    id: 'client',
    title: '1 · Add a client',
    body: 'Clients is where each client gets its own workspace. Nothing is shared between clients. Start by adding one.',
    targets: ['nav a[href$="/settings/workspaces"]'],
  },
  {
    id: 'brand',
    title: '2 · Add a brand',
    body: 'Open the client and add a brand: its voice, audience and the documents Squire answers from. Accounts and posts belong to a brand.',
    targets: ['nav a[href$="/settings/workspaces"]'],
  },
  {
    id: 'accounts',
    title: '3 · Connect social accounts',
    body: 'Connect the brand’s Facebook, Instagram, TikTok, YouTube, LinkedIn, Pinterest or Threads with each platform’s own login.',
    targets: ['nav a[href$="/settings/accounts"]'],
  },
  {
    id: 'ideas',
    title: '4 · Capture ideas',
    body: 'Write ideas down as they come, or ask Squire for ideas based on the brand and what performed well. Turn any idea into a draft.',
    targets: ['nav a[href$="/ideas"]'],
  },
  {
    id: 'create',
    title: '5 · Create a post',
    body: 'Write it once, tailor it for each platform, attach images or video — or generate one with AI — and send it for approval.',
    targets: ['[data-tour="primary-action"]', 'nav a[href$="/posts"]'],
  },
  {
    id: 'approvals',
    title: '6 · Get it approved',
    body: 'Posts wait here for your team and then your client. Every comment and decision is kept.',
    targets: ['nav a[href$="/approvals"]'],
  },
  {
    id: 'calendar',
    title: '7 · Schedule and publish',
    body: 'Pick a time on the calendar or publish now. Each account shows whether its post went out.',
    targets: ['nav a[href$="/calendar"]'],
  },
  {
    id: 'analytics',
    title: '8 · See how it performed',
    body: 'Reactions, comments, shares and views arrive within a few hours of publishing, per post and per account, with client-ready reports.',
    targets: ['nav a[href$="/analytics"]'],
  },
  {
    id: 'community',
    title: '9 · Answer comments and messages',
    body: 'Comments on your posts and private messages arrive in one inbox. Squire can draft the replies; you send them.',
    targets: ['nav a[href$="/community"]'],
  },
  {
    id: 'notifications',
    title: 'Stay in the loop',
    body: 'Approvals waiting, failed posts and new messages arrive here.',
    targets: ['[data-tour="notifications"]'],
  },
  {
    id: 'squire',
    title: 'Or just ask Squire',
    body: 'Every step above can be done by asking Squire in plain language — plan a week, write a post, create an image, check results. Anything that goes out waits for your confirmation.',
    targets: ['[data-tour="squire"]'],
  },
  {
    id: 'done',
    title: 'You’re ready to start',
    body: 'Begin with step 1 on the Today page’s checklist. Take this tour again any time with the ? button at the top.',
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
