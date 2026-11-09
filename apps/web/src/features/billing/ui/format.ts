import { formatBytes } from '@/features/media/ui/facts';
import { PLAN_LIMIT_KEYS, type PlanLimitKey, type PlanLimits } from '../plans';

/**
 * How plan limits read on screen (D-116). Shared by the plan page and the
 * admin surface, so both describe a plan in the same words.
 */

export const LIMIT_LABELS: Record<PlanLimitKey, string> = {
  workspaces: 'Clients',
  socialAccounts: 'Connected accounts',
  aiCreditsPerMonth: 'AI requests a month',
  storageBytes: 'Media storage',
};

export { PLAN_LIMIT_KEYS };

export function formatAmount(key: PlanLimitKey, value: number): string {
  return key === 'storageBytes' ? formatBytes(value) : value.toLocaleString('en-US');
}

/** An absent limit is no limit, never zero. */
export function formatLimit(key: PlanLimitKey, limits: PlanLimits): string {
  const value = limits[key];
  return value === undefined ? 'No limit' : formatAmount(key, value);
}

const STATUS_LABELS: Record<string, string> = {
  TRIALING: 'Trial',
  ACTIVE: 'Active',
  PAST_DUE: 'Payment overdue',
  CANCELED: 'Canceled',
};

export function subscriptionStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}
