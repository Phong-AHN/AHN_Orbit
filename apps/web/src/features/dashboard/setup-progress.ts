/**
 * How far an organization is from being able to publish anything (SRS §29).
 *
 * ## Why this exists
 *
 * Orbit's setup is a chain — organization → client → brand → connected account
 * → post — and every link is required before the next one is possible. You
 * cannot connect a Facebook Page without a brand to attach it to, and you
 * cannot write a useful post without an account to send it to.
 *
 * A brand-new organization used to land on a dashboard of empty sections. Every
 * one of them was accurate and none of them said what to do, so the first
 * screen of the product was a page explaining that there was nothing to see.
 *
 * ## Derived, never stored
 *
 * There is deliberately no `onboardingCompleted` column. A flag and the data
 * drift apart the moment somebody deletes their only workspace: the flag still
 * says finished while the product is unusable again. Counting is cheap and
 * cannot be wrong.
 *
 * This file names no permission string and imports nothing, so it is unit
 * testable — the root Vitest config does not resolve the `@/` alias.
 */

/** What the organization actually has. Counts, not objects. */
export interface SetupCounts {
  workspaces: number;
  brands: number;
  /** Connected and usable. A staged or revoked row is not a connection. */
  accounts: number;
  posts: number;
}

/** Which of the steps this person is allowed to carry out themselves. */
export interface SetupAbilities {
  createWorkspace: boolean;
  createBrand: boolean;
  connectAccount: boolean;
  createPost: boolean;
}

export type SetupStepId = 'workspace' | 'brand' | 'account' | 'post';

export interface SetupStep {
  id: SetupStepId;
  /** What a person would call it, not what the schema calls it. */
  label: string;
  /** One line on why this step exists at all. */
  detail: string;
  done: boolean;
  /** The first step that is not done. Exactly one step is current. */
  current: boolean;
  /** False when this person's role cannot carry out the step. */
  permitted: boolean;
  /** Appended to `/orgs/{slug}`. */
  path: string;
  /** The call to action, naming what happens (SRS §29 copy). */
  action: string;
}

export interface SetupProgress {
  steps: SetupStep[];
  /** Steps completed, for "2 of 4". */
  completed: number;
  /** True once an account is connected *and* a post exists. */
  finished: boolean;
  /**
   * True when the next step needs a role this person does not hold.
   *
   * The interesting case, and the reason `permitted` is separate from `done`: a
   * Content Creator invited to a brand-new agency can do nothing until somebody
   * else adds a client. Showing them a button that would 403 is worse than
   * telling them who to ask.
   */
  blockedOnSomeoneElse: boolean;
}

/**
 * The chain, in dependency order.
 *
 * Numbered in the UI because this genuinely is a sequence — each step is
 * impossible before the one above it. That is the only thing that earns a
 * numbered list.
 */
export function setupProgress(input: {
  counts: SetupCounts;
  abilities: SetupAbilities;
}): SetupProgress {
  const { counts, abilities } = input;

  const defined: Array<Omit<SetupStep, 'current'>> = [
    {
      id: 'workspace',
      label: 'Add your first client',
      detail: 'Each client gets its own workspace. Nothing is shared between them.',
      done: counts.workspaces > 0,
      permitted: abilities.createWorkspace,
      path: '/settings/workspaces',
      action: 'Add a client',
    },
    {
      id: 'brand',
      label: 'Add a brand',
      detail: 'A client can have several brands. Social accounts attach to a brand.',
      done: counts.brands > 0,
      permitted: abilities.createBrand,
      path: '/settings/workspaces',
      action: 'Add a brand',
    },
    {
      id: 'account',
      label: 'Connect a social account',
      detail: 'Facebook, Instagram, TikTok, Threads, LinkedIn, YouTube or Pinterest.',
      done: counts.accounts > 0,
      permitted: abilities.connectAccount,
      path: '/settings/accounts',
      action: 'Connect an account',
    },
    {
      id: 'post',
      label: 'Write your first post',
      detail: 'Draft it, send it for approval, and schedule it.',
      done: counts.posts > 0,
      permitted: abilities.createPost,
      path: '/posts/new',
      action: 'Write a post',
    },
  ];

  /**
   * The first incomplete step is the current one — **even if an earlier step is
   * somehow complete out of order**.
   *
   * It can happen: a workspace can be deleted after its brands were created, so
   * `brands > 0` while `workspaces === 0`. Pointing at the earliest gap rather
   * than at the furthest progress is what makes the guide usable in that state
   * instead of telling somebody to connect an account to a client that no
   * longer exists.
   */
  const currentIndex = defined.findIndex((step) => !step.done);

  const steps: SetupStep[] = defined.map((step, index) => ({
    ...step,
    current: index === currentIndex,
  }));

  const current = currentIndex === -1 ? undefined : steps[currentIndex];

  return {
    steps,
    completed: steps.filter((step) => step.done).length,
    finished: currentIndex === -1,
    blockedOnSomeoneElse: current !== undefined && !current.permitted,
  };
}
