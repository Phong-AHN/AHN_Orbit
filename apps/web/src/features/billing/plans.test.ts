import { describe, expect, it } from 'vitest';
import { planDecisionSchema, planRequestSchema } from './contracts';
import {
  PLANS,
  PLAN_IDS,
  PLAN_LIMIT_KEYS,
  REQUESTABLE_PLAN_IDS,
  TRIAL_LIMITS,
  findPlan,
  hasNoLimits,
  planName,
  readPlanLimits,
} from './plans';
import { formatLimit } from './ui/format';

describe('the plan catalogue (D-116)', () => {
  it('lists each plan id once, in the declared order', () => {
    expect(PLANS.map((plan) => plan.id)).toEqual([...PLAN_IDS]);
  });

  it('keeps the trial exactly as organizations have been getting it', () => {
    // Moving the constant into the catalogue must not change what a new
    // organization starts with.
    expect(TRIAL_LIMITS).toEqual({
      workspaces: 3,
      socialAccounts: 5,
      aiCreditsPerMonth: 50,
      storageBytes: 5 * 1024 ** 3,
    });
  });

  it('never lets anybody ask for the trial', () => {
    expect(findPlan('trial')?.requestable).toBe(false);
    expect(REQUESTABLE_PLAN_IDS).not.toContain('trial');
    expect(REQUESTABLE_PLAN_IDS.length).toBeGreaterThan(0);
  });

  it('gives every plan someone can ask for at least what the trial gives', () => {
    // An absent limit is no limit, so it is always at least the trial's.
    for (const plan of PLANS.filter((p) => p.requestable)) {
      for (const key of PLAN_LIMIT_KEYS) {
        const limit = plan.limits[key];
        if (limit === undefined) continue;
        expect(limit, `${plan.id}.${key}`).toBeGreaterThanOrEqual(TRIAL_LIMITS[key] ?? 0);
      }
    }
  });

  it('has no prices yet: the catalogue is a placeholder until the owner sets them', () => {
    expect(PLANS.every((plan) => plan.price === null)).toBe(true);
  });
});

describe('planName', () => {
  it('names a catalogue plan', () => {
    expect(planName('growth')).toBe('Growth');
  });

  it('still names a plan that is not in the catalogue', () => {
    expect(planName('enterprise')).toBe('Enterprise');
    expect(planName('')).toBe('Unknown');
  });
});

describe('readPlanLimits', () => {
  it('keeps the four limits it knows', () => {
    expect(readPlanLimits({ workspaces: 3, storageBytes: 10 })).toEqual({
      workspaces: 3,
      storageBytes: 10,
    });
  });

  it('drops anything that is not a whole, non-negative number', () => {
    expect(
      readPlanLimits({
        workspaces: '3',
        socialAccounts: -1,
        aiCreditsPerMonth: 1.5,
        storageBytes: null,
        seats: 5,
      }),
    ).toEqual({});
  });

  it('reads a missing or malformed column as no limits', () => {
    expect(readPlanLimits(null)).toEqual({});
    expect(readPlanLimits([1, 2])).toEqual({});
    expect(readPlanLimits('{}')).toEqual({});
  });

  it('treats an empty object as an organization with no limits at all (D-113)', () => {
    expect(hasNoLimits(readPlanLimits({}))).toBe(true);
    expect(hasNoLimits(TRIAL_LIMITS)).toBe(false);
  });
});

describe('formatLimit', () => {
  it('says "No limit" for an absent limit, never zero', () => {
    expect(formatLimit('workspaces', {})).toBe('No limit');
    expect(formatLimit('workspaces', { workspaces: 0 })).toBe('0');
  });

  it('writes storage in bytes units and counts as numbers', () => {
    expect(formatLimit('storageBytes', { storageBytes: 20 * 1024 ** 3 })).toBe('20 GB');
    expect(formatLimit('aiCreditsPerMonth', { aiCreditsPerMonth: 1_000 })).toBe('1,000');
  });
});

describe('planRequestSchema', () => {
  it('accepts a plan someone may ask for, with or without a note', () => {
    expect(planRequestSchema.parse({ plan: 'growth' })).toEqual({ plan: 'growth' });
    expect(planRequestSchema.parse({ plan: 'starter', note: '  call Lan  ' })).toEqual({
      plan: 'starter',
      note: 'call Lan',
    });
  });

  it('refuses the trial and anything outside the catalogue', () => {
    expect(planRequestSchema.safeParse({ plan: 'trial' }).success).toBe(false);
    expect(planRequestSchema.safeParse({ plan: 'enterprise' }).success).toBe(false);
  });

  it('carries nothing about what a plan grants', () => {
    const parsed = planRequestSchema.parse({ plan: 'growth', limits: {}, status: 'ACTIVE' });
    expect(parsed).toEqual({ plan: 'growth' });
  });

  it('keeps the note short', () => {
    expect(planRequestSchema.safeParse({ plan: 'growth', note: 'x'.repeat(501) }).success).toBe(
      false,
    );
  });
});

describe('planDecisionSchema', () => {
  it('needs a decision and a reason a sentence long', () => {
    expect(
      planDecisionSchema.safeParse({ decision: 'APPROVE', reason: 'Paid by transfer, INV-1' })
        .success,
    ).toBe(true);
    expect(planDecisionSchema.safeParse({ decision: 'APPROVE', reason: 'ok' }).success).toBe(false);
    expect(
      planDecisionSchema.safeParse({ decision: 'GRANT', reason: 'a long enough reason' }).success,
    ).toBe(false);
  });

  it('cannot name a plan: the plan applied is the one that was asked for', () => {
    const parsed = planDecisionSchema.parse({
      decision: 'APPROVE',
      reason: 'Paid by transfer, INV-1',
      plan: 'agency',
    });
    expect(parsed).not.toHaveProperty('plan');
  });
});
