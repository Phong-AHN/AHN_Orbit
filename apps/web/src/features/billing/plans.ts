/**
 * The plans an organization can be on (D-116).
 *
 * **Placeholder catalogue.** The owner asked for the upgrade flow first, with
 * each plan's contents and price to follow. The names, summaries and limits of
 * the paid plans below are stand-ins, and no plan has a price yet. When the real
 * catalogue arrives it is edited here and nowhere else: the plan page, the
 * request contract and an administrator's approval all read this list.
 *
 * Editing a plan changes what an *approval* grants from then on. It does not
 * touch an organization already on that plan, because each organization's
 * limits are stored on its own `Subscription` row when the plan is applied.
 *
 * Kept free of server imports so the plan page's browser components can use it.
 */

/**
 * The four limits the product enforces. An absent key means **no limit**: each
 * check reads its key and skips when it is missing (D-113), so `{}` is an
 * organization with no caps at all.
 *
 * A type alias rather than an interface so that it is assignable to Prisma's
 * JSON input type when it is written to `Subscription.limits`.
 */
export type PlanLimits = {
  workspaces?: number;
  socialAccounts?: number;
  /** One credit per AI request, not per token (T4.3). */
  aiCreditsPerMonth?: number;
  storageBytes?: number;
};

export const PLAN_LIMIT_KEYS = [
  'workspaces',
  'socialAccounts',
  'aiCreditsPerMonth',
  'storageBytes',
] as const satisfies readonly (keyof PlanLimits)[];

export type PlanLimitKey = (typeof PLAN_LIMIT_KEYS)[number];

export const PLAN_IDS = ['trial', 'starter', 'growth', 'agency'] as const;

export type PlanId = (typeof PLAN_IDS)[number];

export interface Plan {
  id: PlanId;
  name: string;
  summary: string;
  limits: PlanLimits;
  /** Shown as written. `null` until the plan is priced. */
  price: string | null;
  /** False for the plan everybody starts on: nobody asks to be put on a trial. */
  requestable: boolean;
}

const GB = 1024 ** 3;

export const PLANS: readonly Plan[] = [
  {
    id: 'trial',
    name: 'Trial',
    summary: 'Where every new organization starts.',
    limits: { workspaces: 3, socialAccounts: 5, aiCreditsPerMonth: 50, storageBytes: 5 * GB },
    price: null,
    requestable: false,
  },
  {
    id: 'starter',
    name: 'Starter',
    summary: 'For a small team looking after a handful of clients.',
    limits: { workspaces: 5, socialAccounts: 15, aiCreditsPerMonth: 300, storageBytes: 20 * GB },
    price: null,
    requestable: true,
  },
  {
    id: 'growth',
    name: 'Growth',
    summary: 'For an agency adding clients every month.',
    limits: {
      workspaces: 15,
      socialAccounts: 50,
      aiCreditsPerMonth: 1_000,
      storageBytes: 100 * GB,
    },
    price: null,
    requestable: true,
  },
  {
    id: 'agency',
    name: 'Agency',
    summary: 'For agencies running many brands, with no cap on clients.',
    limits: { socialAccounts: 150, aiCreditsPerMonth: 3_000, storageBytes: 500 * GB },
    price: null,
    requestable: true,
  },
];

export function findPlan(id: string): Plan | undefined {
  return PLANS.find((plan) => plan.id === id);
}

/** The plans an organization may ask to move to. */
export const REQUESTABLE_PLAN_IDS = PLANS.filter((plan) => plan.requestable).map(
  (plan) => plan.id,
) as [PlanId, ...PlanId[]];

/**
 * What a new organization gets. The trial entry is the single source: the
 * organization-creation path reads it from here.
 */
export const TRIAL_LIMITS: PlanLimits = PLANS[0]!.limits;

/**
 * A plan's display name, including for a plan id that is not in the catalogue
 * (a row written before the catalogue existed, or by the seed script).
 */
export function planName(id: string): string {
  const known = findPlan(id);
  if (known) return known.name;
  return id.length === 0 ? 'Unknown' : id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * Read `Subscription.limits` (jsonb) into the four known limits.
 *
 * Anything that is not a non-negative whole number is dropped rather than
 * trusted, which reads it the same way the limit checks do: a key that is not a
 * usable number imposes nothing.
 */
export function readPlanLimits(value: unknown): PlanLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const limits: PlanLimits = {};
  for (const key of PLAN_LIMIT_KEYS) {
    const raw = source[key];
    if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) limits[key] = raw;
  }
  return limits;
}

/** True when no limit applies at all: the internal organizations of D-113. */
export function hasNoLimits(limits: PlanLimits): boolean {
  return PLAN_LIMIT_KEYS.every((key) => limits[key] === undefined);
}
