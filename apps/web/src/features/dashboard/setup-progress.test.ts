import { describe, expect, it } from 'vitest';
import { setupProgress, type SetupAbilities, type SetupCounts } from './setup-progress';

/**
 * The first screen a new agency sees, and the path it follows.
 *
 * The cases worth having are the ones where a naive implementation says
 * something false: a role that cannot carry out the next step, a role handed
 * a checklist it can never finish, and data that completed out of order.
 */

const empty: SetupCounts = {
  workspaces: 0,
  brands: 0,
  accounts: 0,
  ideas: 0,
  posts: 0,
  published: 0,
  measured: 0,
  replies: 0,
};

const ready: SetupCounts = { ...empty, workspaces: 1, brands: 1, accounts: 1 };

const everything: SetupCounts = {
  workspaces: 2,
  brands: 3,
  accounts: 4,
  ideas: 5,
  posts: 10,
  published: 6,
  measured: 6,
  replies: 3,
};

const owner: SetupAbilities = {
  createWorkspace: true,
  createBrand: true,
  connectAccount: true,
  createPost: true,
  readAnalytics: true,
  reply: true,
};

/** A Content Creator: writes posts, sets up nothing, answers nobody. */
const creator: SetupAbilities = {
  ...owner,
  createWorkspace: false,
  createBrand: false,
  connectAccount: false,
  reply: false,
};

/** An Approver: reviews. Creates nothing, reads results. */
const approver: SetupAbilities = {
  createWorkspace: false,
  createBrand: false,
  connectAccount: false,
  createPost: false,
  readAnalytics: true,
  reply: false,
};

const currentId = (counts: SetupCounts, abilities = owner) =>
  setupProgress({ counts, abilities }).steps.find((step) => step.current)?.id;

describe('the path a new agency follows', () => {
  it('goes client → brand → accounts → idea → post → publish → results → replies', () => {
    expect(setupProgress({ counts: empty, abilities: owner }).steps.map((s) => s.id)).toEqual([
      'workspace',
      'brand',
      'account',
      'idea',
      'post',
      'publish',
      'results',
      'engage',
    ]);
  });

  it('advances one step at a time as each piece appears', () => {
    expect(currentId(empty)).toBe('workspace');
    expect(currentId({ ...empty, workspaces: 1 })).toBe('brand');
    expect(currentId({ ...empty, workspaces: 1, brands: 1 })).toBe('account');
    expect(currentId(ready)).toBe('idea');
    expect(currentId({ ...ready, ideas: 1 })).toBe('post');
    expect(currentId({ ...ready, ideas: 1, posts: 1 })).toBe('publish');
    expect(currentId({ ...ready, ideas: 1, posts: 1, published: 1 })).toBe('results');
    expect(currentId({ ...ready, ideas: 1, posts: 1, published: 1, measured: 1 })).toBe('engage');
  });

  it('has exactly one current step until it is finished', () => {
    const progress = setupProgress({ counts: ready, abilities: owner });
    expect(progress.steps.filter((step) => step.current)).toHaveLength(1);
  });

  it('is ready to publish once client, brand and account exist — the rest is the first run', () => {
    expect(
      setupProgress({ counts: { ...empty, workspaces: 1, brands: 1 }, abilities: owner }).ready,
    ).toBe(false);
    const progress = setupProgress({ counts: ready, abilities: owner });
    expect(progress.ready).toBe(true);
    expect(progress.finished).toBe(false);
  });

  it('does not send an agency already writing posts back to ideas', () => {
    expect(currentId({ ...ready, posts: 3 })).toBe('publish');
  });

  it('reports finished with no current step once everything happened', () => {
    const progress = setupProgress({ counts: everything, abilities: owner });
    expect(progress.finished).toBe(true);
    expect(progress.completed).toBe(8);
    expect(progress.steps.some((step) => step.current)).toBe(false);
    expect(progress.blockedOnSomeoneElse).toBe(false);
  });
});

describe('a role that cannot do every step', () => {
  /**
   * A Content Creator invited to a brand-new agency can do nothing until
   * somebody adds a client. Offering them a button that would 403 is worse
   * than telling them who to ask.
   */
  it('says the next required step is somebody else’s to do', () => {
    const progress = setupProgress({ counts: empty, abilities: creator });
    expect(progress.blockedOnSomeoneElse).toBe(true);
    expect(progress.steps.find((step) => step.current)?.permitted).toBe(false);
  });

  it('lists only the first-run steps the role can do', () => {
    const ids = setupProgress({ counts: ready, abilities: creator }).steps.map((s) => s.id);
    expect(ids).toContain('post');
    expect(ids).not.toContain('engage');

    const approverIds = setupProgress({ counts: ready, abilities: approver }).steps.map(
      (s) => s.id,
    );
    expect(approverIds).toEqual(['workspace', 'brand', 'account', 'results']);
  });

  it('lets a role finish the checklist it was given', () => {
    const progress = setupProgress({
      counts: { ...ready, published: 1, measured: 1 },
      abilities: approver,
    });
    expect(progress.finished).toBe(true);
  });

  it('keeps earlier steps marked done regardless of permission', () => {
    const progress = setupProgress({
      counts: { ...empty, workspaces: 1, brands: 1 },
      abilities: creator,
    });
    expect(progress.steps.find((s) => s.id === 'workspace')?.done).toBe(true);
    expect(progress.steps.find((s) => s.id === 'brand')?.done).toBe(true);
    expect(progress.completed).toBe(2);
  });
});

describe('data that completed out of order', () => {
  /**
   * Delete the only workspace after its brands existed, and `brands > 0` while
   * `workspaces === 0`. The guide must point at the **earliest** gap.
   */
  it('points at the earliest gap, not the furthest progress', () => {
    const progress = setupProgress({ counts: { ...everything, workspaces: 0 }, abilities: owner });
    expect(progress.steps.find((step) => step.current)?.id).toBe('workspace');
    expect(progress.ready).toBe(false);
    expect(progress.finished).toBe(false);
    expect(progress.steps.find((s) => s.id === 'brand')?.done).toBe(true);
  });
});

describe('the copy', () => {
  it('gives every step an action, a destination and an explanation', () => {
    const progress = setupProgress({ counts: empty, abilities: owner });
    for (const step of progress.steps) {
      expect(step.action.length).toBeGreaterThan(0);
      expect(step.path.startsWith('/')).toBe(true);
      expect(step.detail.length).toBeGreaterThan(0);
      expect(step.label).not.toMatch(/workspaceId|socialAccount|postVariant/);
    }
  });
});
