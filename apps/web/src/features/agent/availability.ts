import { serverEnv } from '@orbit/config';

/**
 * Which organizations may use AI agents (D-109): `AGENT_ENABLED_ORGS`, a list
 * of slugs or ids, or `*`. Unset means nowhere — the rollout switch and the
 * kill switch are the same variable, and checked on every call rather than
 * only when a grant is made, so turning it off stops existing grants at once.
 */
function enabledList(): readonly string[] {
  return (serverEnv().AGENT_ENABLED_ORGS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function agentsEnabledAnywhere(): boolean {
  return enabledList().length > 0;
}

export function agentEnabledFor(organization: { id: string; slug: string }): boolean {
  const list = enabledList();
  return (
    list.includes('*') ||
    list.includes(organization.id.toLowerCase()) ||
    list.includes(organization.slug.toLowerCase())
  );
}
