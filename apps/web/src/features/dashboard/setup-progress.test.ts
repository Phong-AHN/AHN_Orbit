import { describe, expect, it } from 'vitest';
import { setupProgress, type SetupAbilities, type SetupCounts } from './setup-progress';

/**
 * The first screen a new agency sees.
 *
 * The cases worth having are the ones where a naive implementation says
 * something false: a role that cannot carry out the next step, and data that
 * completed out of order because something was deleted.
 */

const empty: SetupCounts = { workspaces: 0, brands: 0, accounts: 0, posts: 0 };

const owner: SetupAbilities = {
  createWorkspace: true,
  createBrand: true,
  connectAccount: true,
  createPost: true,
};

/** A Content Creator: may write posts, may not set up clients or connections. */
const creator: SetupAbilities = {
  createWorkspace: false,
  createBrand: false,
  connectAccount: false,
  createPost: true,
};

describe('a brand-new organization', () => {
  it('points at adding a client, and nothing further', () => {
    const progress = setupProgress({ counts: empty, abilities: owner });

    expect(progress.completed).toBe(0);
    expect(progress.finished).toBe(false);
    expect(progress.steps.find((step) => step.current)?.id).toBe('workspace');
    // Exactly one step is current, or the guide reads as four simultaneous
    // instructions.
    expect(progress.steps.filter((step) => step.current)).toHaveLength(1);
  });

  it('advances one step at a time as each link appears', () => {
    const afterWorkspace = setupProgress({
      counts: { ...empty, workspaces: 1 },
      abilities: owner,
    });
    expect(afterWorkspace.steps.find((s) => s.current)?.id).toBe('brand');
    expect(afterWorkspace.completed).toBe(1);

    const afterBrand = setupProgress({
      counts: { ...empty, workspaces: 1, brands: 1 },
      abilities: owner,
    });
    expect(afterBrand.steps.find((s) => s.current)?.id).toBe('account');

    const afterAccount = setupProgress({
      counts: { workspaces: 1, brands: 1, accounts: 1, posts: 0 },
      abilities: owner,
    });
    expect(afterAccount.steps.find((s) => s.current)?.id).toBe('post');
  });
});

describe('a finished setup', () => {
  /**
   * The guide has to get out of the way on its own. There is no dismiss button
   * and no stored flag, so this is the only thing that hides it.
   */
  it('reports finished with no current step', () => {
    const progress = setupProgress({
      counts: { workspaces: 2, brands: 3, accounts: 4, posts: 10 },
      abilities: owner,
    });

    expect(progress.finished).toBe(true);
    expect(progress.completed).toBe(4);
    expect(progress.steps.some((step) => step.current)).toBe(false);
    expect(progress.blockedOnSomeoneElse).toBe(false);
  });
});

describe('a role that cannot do the next step', () => {
  /**
   * **The case that matters.** A Content Creator invited to a brand-new agency
   * can do nothing until somebody adds a client. Offering them a button that
   * would 403 is worse than telling them who to ask.
   */
  it('says the next step is somebody else’s to do', () => {
    const progress = setupProgress({ counts: empty, abilities: creator });

    expect(progress.blockedOnSomeoneElse).toBe(true);
    expect(progress.steps.find((step) => step.current)?.permitted).toBe(false);
  });

  /** Once the blocking step is done, their own step becomes actionable. */
  it('stops being blocked when the step they can do comes round', () => {
    const progress = setupProgress({
      counts: { workspaces: 1, brands: 1, accounts: 1, posts: 0 },
      abilities: creator,
    });

    expect(progress.steps.find((step) => step.current)?.id).toBe('post');
    expect(progress.blockedOnSomeoneElse).toBe(false);
  });

  /** Permission is never confused with completion: a done step stays done. */
  it('keeps earlier steps marked done regardless of permission', () => {
    const progress = setupProgress({
      counts: { workspaces: 1, brands: 1, accounts: 0, posts: 0 },
      abilities: creator,
    });

    expect(progress.steps.find((s) => s.id === 'workspace')?.done).toBe(true);
    expect(progress.steps.find((s) => s.id === 'brand')?.done).toBe(true);
    expect(progress.completed).toBe(2);
  });
});

describe('data that completed out of order', () => {
  /**
   * Real and reachable: delete the only workspace after its brands existed, and
   * `brands > 0` while `workspaces === 0`.
   *
   * The guide must point at the **earliest** gap. Pointing at the furthest
   * progress would tell somebody to connect an account to a client that no
   * longer exists.
   */
  it('points at the earliest gap, not the furthest progress', () => {
    const progress = setupProgress({
      counts: { workspaces: 0, brands: 2, accounts: 1, posts: 5 },
      abilities: owner,
    });

    expect(progress.steps.find((step) => step.current)?.id).toBe('workspace');
    expect(progress.finished).toBe(false);
    // Still honest about what exists, rather than resetting the later steps.
    expect(progress.steps.find((s) => s.id === 'brand')?.done).toBe(true);
  });
});

describe('the copy', () => {
  /**
   * Every step has to say what happens when it is used. A step with a label and
   * no action is a heading, and a person cannot act on a heading (SRS §29).
   */
  it('gives every step an action and a destination', () => {
    const progress = setupProgress({ counts: empty, abilities: owner });

    for (const step of progress.steps) {
      expect(step.action.length).toBeGreaterThan(0);
      expect(step.path.startsWith('/')).toBe(true);
      expect(step.detail.length).toBeGreaterThan(0);
      // Nothing in the copy should leak a schema word at somebody.
      expect(step.label).not.toMatch(/workspaceId|socialAccount|postVariant/);
    }
  });
});
