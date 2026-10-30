import {
  ForbiddenError,
  isUserPrincipal,
  type AgentDelegation,
  type AgentScope,
  type PostStatus,
  type TenantContext,
} from '@orbit/core';
import type { Permission } from './permissions.js';

/**
 * What an AI agent may do for a user (**D-109**, docs/AGENT-MCP-PLAN.md §3).
 *
 * An agent never has rights of its own. Under a delegation, a permission is
 * allowed only when **all** of these hold:
 *
 *  1. the user's own role grants it here (the ordinary policy, unchanged);
 *  2. one of the scopes the user gave the agent covers it (this map);
 *  3. if it acts outside the agency, the user confirmed this exact action
 *     outside the model (`confirmedActionId`).
 *
 * The map is an allowlist. A permission missing from every scope — inviting
 * members, connecting accounts, deleting anything, billing, the assistant's
 * AUTO mode — is refused to every agent whatever the user's role, which is
 * what makes "the chatbot cannot do X" a property of the engine rather than of
 * which tools happen to exist. Adding a permission to the catalogue leaves it
 * out of here, and so denied to agents, until someone decides otherwise.
 */
export const AGENT_SCOPE_PERMISSIONS: Readonly<Record<AgentScope, readonly Permission[]>> = {
  read: [
    'org:read',
    'workspace:read',
    'brand:read',
    'brand_voice:read',
    'social_account:read',
    'post:read',
    'task:read',
    'comment:read_internal',
    'media:read',
    'analytics:read',
    'report:export',
    'ai:view_usage',
  ],
  content: [
    'post:create',
    'post:update',
    'post:submit_internal_review',
    'task:create',
    'task:update',
    'comment:create',
    'comment:resolve',
    'media:upload',
    'media:update',
    'report:generate',
    'ai:generate',
  ],
  workflow: [
    'post:submit_client_review',
    'post:approve_internal',
    'post:request_changes',
    'post:schedule',
    'post:reschedule',
    'post:publish_now',
    'post:cancel_scheduled',
    'post:retry_failed',
  ],
  engagement: ['message:read', 'comment:read_public', 'message:reply', 'comment:reply'],
};

/**
 * Permissions an agent may use only on an action the user confirmed (§5).
 *
 * Everything here puts something in front of a client, an audience or a
 * platform, or takes it away again.
 *
 * Replying is the other outward act, and it is guarded where it happens
 * rather than here: `message:reply` and `comment:reply` also cover drafting a
 * suggestion and triaging a conversation, which an agent should do freely. So
 * the two routes that actually send call `assertAgentConfirmed` themselves,
 * and a test holds them to it.
 */
export const AGENT_CONFIRMATION_REQUIRED: readonly Permission[] = [
  'post:submit_client_review',
  'post:approve_internal',
  'post:request_changes',
  'post:schedule',
  'post:reschedule',
  'post:publish_now',
  'post:cancel_scheduled',
  'post:retry_failed',
];

/**
 * The status changes an agent may make without a confirmation.
 *
 * Transitions are checked against the permission the state machine names, and
 * some of those are ordinary editing permissions — pulling a post off the
 * schedule (SCHEDULED → DRAFT) needs only `post:update`. So transitions get
 * their own allowlist: an agent may move work *towards* review on its own, and
 * nothing else.
 */
export const AGENT_DIRECT_TRANSITIONS: ReadonlyArray<{ from: PostStatus; to: PostStatus }> = [
  { from: 'IDEA', to: 'DRAFT' },
  { from: 'DRAFT', to: 'INTERNAL_REVIEW' },
  { from: 'CHANGES_REQUESTED', to: 'DRAFT' },
];

const BY_SCOPE: ReadonlyMap<AgentScope, ReadonlySet<Permission>> = new Map(
  (Object.entries(AGENT_SCOPE_PERMISSIONS) as [AgentScope, readonly Permission[]][]).map(
    ([scope, permissions]) => [scope, new Set(permissions)],
  ),
);
const CONFIRMED: ReadonlySet<Permission> = new Set(AGENT_CONFIRMATION_REQUIRED);

export type AgentDenial = 'OUTSIDE_AGENT_SCOPE' | 'AGENT_CONFIRMATION_REQUIRED';

/** Whether any of the delegation's scopes covers the permission at all. */
export function agentScopeCovers(delegation: AgentDelegation, permission: Permission): boolean {
  return delegation.scopes.some((scope) => BY_SCOPE.get(scope)?.has(permission) ?? false);
}

/** Conditions 2 and 3 above. `null` means the agent gate has no objection. */
export function agentDenial(
  delegation: AgentDelegation,
  permission: Permission,
): AgentDenial | null {
  if (!agentScopeCovers(delegation, permission)) return 'OUTSIDE_AGENT_SCOPE';
  if (CONFIRMED.has(permission) && !delegation.confirmedActionId) {
    return 'AGENT_CONFIRMATION_REQUIRED';
  }
  return null;
}

export function requiresAgentConfirmation(permission: Permission): boolean {
  return CONFIRMED.has(permission);
}

export function isAgentDirectTransition(from: PostStatus, to: PostStatus): boolean {
  return AGENT_DIRECT_TRANSITIONS.some((move) => move.from === from && move.to === to);
}

/**
 * Refuse an unconfirmed agent at the point something is sent (§5).
 *
 * For outward acts whose permission also covers inward ones — sending a
 * reply, where `message:reply` also lets an agent draft and triage. A person
 * is never affected; an agent passes only while executing an action its user
 * confirmed outside the model.
 */
export function assertAgentConfirmed(ctx: TenantContext, action: string): void {
  if (!isUserPrincipal(ctx.principal)) return;
  const delegation = ctx.principal.delegation;
  if (!delegation || delegation.confirmedActionId) return;

  throw new ForbiddenError(`Agent action needs confirmation: ${action}`, {
    userMessage: 'This needs your confirmation in Social Square before it is sent.',
    context: {
      action,
      reason: 'AGENT_CONFIRMATION_REQUIRED',
      organizationId: ctx.organizationId,
      actor: ctx.principal.userId,
      channel: delegation.channel,
    },
  });
}
