/**
 * How far an organization is through getting started (SRS §29).
 *
 * ## Two parts
 *
 * **Setup** is a chain — client → brand → connected account — and every link
 * is required before the next one is possible: you cannot connect a Facebook
 * Page without a brand to attach it to. Until it is done the guide is the
 * whole dashboard, because there is nothing else to show.
 *
 * **The first run** follows one piece of content the whole way, as a new
 * person should see it once: capture an idea, write the post, get it
 * published, read how it did, answer the comments and messages it brought.
 * These steps sit above the dashboard rather than replacing it, and only the
 * ones this person's role can do are listed — an Approver is not handed a
 * checklist they can never finish.
 *
 * ## Derived, never stored
 *
 * There is deliberately no `onboardingCompleted` column. A flag and the data
 * drift apart the moment somebody deletes their only workspace: the flag still
 * says finished while the product is unusable again. Counting is cheap and
 * cannot be wrong.
 *
 * This file names no permission string and imports nothing, so it is unit
 * testable.
 */

/** What the organization actually has. Counts, not objects. */
export interface SetupCounts {
  workspaces: number;
  brands: number;
  /** Connected and usable. A staged or revoked row is not a connection. */
  accounts: number;
  ideas: number;
  posts: number;
  /** Posts that went out, on at least one account. */
  published: number;
  /** Published posts the platforms have reported numbers for. */
  measured: number;
  /** Comments or private messages answered. */
  replies: number;
}

/** Which of the steps this person is allowed to carry out themselves. */
export interface SetupAbilities {
  createWorkspace: boolean;
  createBrand: boolean;
  connectAccount: boolean;
  createPost: boolean;
  readAnalytics: boolean;
  /** Reply to a comment or a private message. */
  reply: boolean;
}

export type SetupStepId =
  'workspace' | 'brand' | 'account' | 'idea' | 'post' | 'publish' | 'results' | 'engage';

export interface SetupStep {
  id: SetupStepId;
  /** What a person would call it, not what the schema calls it. */
  label: string;
  /** One line on what to do and why. */
  detail: string;
  done: boolean;
  /** The first step that is not done. At most one step is current. */
  current: boolean;
  /** False when this person's role cannot carry out the step. */
  permitted: boolean;
  /** Part of the required setup chain rather than the first run. */
  required: boolean;
  /** Appended to `/orgs/{slug}`. */
  path: string;
  /** The call to action, naming what happens (SRS §29 copy). */
  action: string;
}

export interface SetupProgress {
  steps: SetupStep[];
  /** Steps completed, for "5 of 8". */
  completed: number;
  /** The required chain is done: the agency can publish. */
  ready: boolean;
  /** Every listed step is done; the guide can leave. */
  finished: boolean;
  /**
   * True when the next step needs a role this person does not hold.
   *
   * A Content Creator invited to a brand-new agency can do nothing until
   * somebody else adds a client. Showing them a button that would 403 is
   * worse than telling them who to ask.
   */
  blockedOnSomeoneElse: boolean;
}

/** In order: each step is what a new person does next. */
export function setupProgress(input: {
  counts: SetupCounts;
  abilities: SetupAbilities;
}): SetupProgress {
  const { counts, abilities } = input;

  const defined: Array<Omit<SetupStep, 'current'>> = [
    {
      id: 'workspace',
      label: 'Add your first client',
      detail: 'Each client gets its own workspace. Nothing is shared between clients.',
      done: counts.workspaces > 0,
      permitted: abilities.createWorkspace,
      required: true,
      path: '/settings/workspaces',
      action: 'Add a client',
    },
    {
      id: 'brand',
      label: 'Add a brand to the client',
      detail:
        'Open the client and add a brand — its voice, audience and documents. Social accounts attach to a brand.',
      done: counts.brands > 0,
      permitted: abilities.createBrand,
      required: true,
      path: '/settings/workspaces',
      action: 'Add a brand',
    },
    {
      id: 'account',
      label: 'Connect the brand’s social accounts',
      detail: 'Facebook, Instagram, TikTok, Threads, LinkedIn, YouTube or Pinterest.',
      done: counts.accounts > 0,
      permitted: abilities.connectAccount,
      required: true,
      path: '/settings/accounts',
      action: 'Connect an account',
    },
    {
      id: 'idea',
      label: 'Capture a content idea',
      detail: 'Write one down, or ask Squire for ideas grounded in the brand’s voice.',
      // An agency already writing posts does not need to be sent back to ideas.
      done: counts.ideas > 0 || counts.posts > 0,
      permitted: abilities.createPost,
      required: false,
      path: '/ideas',
      action: 'Add an idea',
    },
    {
      id: 'post',
      label: 'Create your first post',
      detail: 'Write it once, tailor it for each platform, attach media and send it for approval.',
      done: counts.posts > 0,
      permitted: abilities.createPost,
      required: false,
      path: '/posts/new',
      action: 'Write a post',
    },
    {
      id: 'publish',
      label: 'Schedule or publish it',
      detail:
        'Once approved, pick a time on the calendar or publish now. Its status shows per account.',
      done: counts.published > 0,
      permitted: abilities.createPost,
      required: false,
      path: '/calendar',
      action: 'Open the calendar',
    },
    {
      id: 'results',
      label: 'See how it performed',
      detail:
        'Reactions, comments, shares and views arrive within a few hours of publishing. A number the platform has not reported shows as missing, never zero.',
      done: counts.measured > 0,
      permitted: abilities.readAnalytics,
      required: false,
      path: '/analytics',
      action: 'Open analytics',
    },
    {
      id: 'engage',
      label: 'Answer comments and messages',
      detail:
        'Comments on your posts and private messages arrive in one inbox. Squire can draft replies from the brand’s documents.',
      done: counts.replies > 0,
      permitted: abilities.reply,
      required: false,
      path: '/community',
      action: 'Open the inbox',
    },
  ];

  // The required chain is always listed — who can do it is the question it
  // answers. The first run lists only what this person can do themselves.
  const listed = defined.filter((step) => step.required || step.permitted);

  /**
   * The first incomplete step is the current one — **even if a later step is
   * complete**. A workspace can be deleted after its brands were created, so
   * `brands > 0` while `workspaces === 0`; pointing at the earliest gap is what
   * stops the guide telling somebody to connect an account to a client that
   * no longer exists.
   */
  const currentIndex = listed.findIndex((step) => !step.done);
  const steps: SetupStep[] = listed.map((step, index) => ({
    ...step,
    current: index === currentIndex,
  }));
  const current = currentIndex === -1 ? undefined : steps[currentIndex];

  return {
    steps,
    completed: steps.filter((step) => step.done).length,
    ready: steps.filter((step) => step.required).every((step) => step.done),
    finished: currentIndex === -1,
    blockedOnSomeoneElse: current !== undefined && !current.permitted,
  };
}
