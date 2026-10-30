import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  AGENT_SCOPES,
  ConflictError,
  NotFoundError,
  PlanLimitExceededError,
  clock,
  isUserPrincipal,
  type AgentScope,
  type TenantContext,
} from '@orbit/core';
import { systemContext } from '@orbit/auth';
import { serverEnv } from '@orbit/config';
import { withTenant, type Prisma } from '@orbit/db';
import { logger } from '@orbit/observability';
import { runAsAgent, type AgentInvocation } from '@/server/agent-invocation';
import { AgentToolError, routeCall } from './dispatch';
import { ROUTES } from './routes';
import type { ActionRequest, PreparedAction } from './types';

/**
 * Outward actions, prepared by an agent and confirmed by a person (D-109 §5).
 *
 * The agent never executes one. It stores the exact route call and a summary
 * the server wrote from it; the person reads that summary in Social Square and
 * confirms, and only then does the call run — once, as written, with the
 * person's rights checked again at that moment. The confirmation is a click in
 * Social Square under the person's own session, which no model can make.
 */

const TTL_MS = 15 * 60_000;
const MAX_PENDING_PER_USER = 20;
const METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** Database scoping only. The rights that matter are checked by the route the action calls. */
const scoped = (organizationId: string) =>
  systemContext({ organizationId, actorName: 'agent-actions', capabilities: [] });

function sign(request: ActionRequest): string {
  return createHmac('sha256', Buffer.from(serverEnv().STATE_SIGNING_SECRET, 'base64'))
    .update(`agent-action:${JSON.stringify(request)}`)
    .digest('base64url');
}

function signatureMatches(request: ActionRequest, stored: string): boolean {
  const expected = Buffer.from(sign(request));
  const actual = Buffer.from(stored);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function isActionRequest(value: unknown): value is ActionRequest {
  const request = value as Partial<ActionRequest> | null;
  return (
    typeof request === 'object' &&
    request !== null &&
    typeof request.route === 'string' &&
    Object.hasOwn(ROUTES, request.route) &&
    typeof request.method === 'string' &&
    METHODS.has(request.method) &&
    typeof request.params === 'object' &&
    request.params !== null &&
    Object.values(request.params).every((v) => typeof v === 'string')
  );
}

export interface PreparedActionView {
  id: string;
  summary: string;
  expiresAt: string;
  confirmUrl: string;
}

export async function prepareAction(
  invocation: AgentInvocation,
  tool: string,
  prepared: PreparedAction,
  link: { origin: string; organizationSlug: string },
): Promise<PreparedActionView> {
  const now = clock.now();

  const row = await withTenant(scoped(invocation.organizationId), async (db) => {
    const pending = await db.agentAction.count({
      where: { userId: invocation.userId, status: 'PENDING', expiresAt: { gt: now } },
    });
    if (pending >= MAX_PENDING_PER_USER) {
      throw new PlanLimitExceededError('Too many unconfirmed agent actions', {
        userMessage: `You have ${pending} actions waiting for confirmation. Confirm or reject some in Social Square first.`,
      });
    }

    return db.agentAction.create({
      data: {
        organizationId: invocation.organizationId,
        userId: invocation.userId,
        channel: invocation.delegation.channel,
        grantId: invocation.delegation.grantId ?? null,
        tool,
        summary: prepared.summary,
        request: prepared.request as unknown as Prisma.InputJsonValue,
        requestHash: sign(prepared.request),
        expiresAt: new Date(now.getTime() + TTL_MS),
      },
      select: { id: true, summary: true, expiresAt: true },
    });
  });

  return {
    id: row.id,
    summary: row.summary,
    expiresAt: row.expiresAt.toISOString(),
    confirmUrl: `${link.origin}/orgs/${encodeURIComponent(link.organizationSlug)}/agent-actions?action=${row.id}`,
  };
}

const ACTION_SELECT = {
  id: true,
  channel: true,
  tool: true,
  summary: true,
  status: true,
  expiresAt: true,
  decidedAt: true,
  error: true,
  createdAt: true,
} as const;

function personOf(ctx: TenantContext): string {
  // Confirming is a person's act in their own session. An agent can neither
  // list nor decide actions, whatever route it reaches.
  if (!isUserPrincipal(ctx.principal) || ctx.principal.delegation) {
    throw new NotFoundError('Agent action');
  }
  return ctx.principal.userId;
}

/** The person's own actions, newest first. Nobody sees another person's. */
export async function listMyActions(ctx: TenantContext) {
  const userId = personOf(ctx);
  const now = clock.now();
  const rows = await withTenant(ctx, (db) =>
    db.agentAction.findMany({
      where: { userId },
      select: ACTION_SELECT,
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
  );
  return rows.map((row) => ({
    ...row,
    status: row.status === 'PENDING' && row.expiresAt <= now ? ('EXPIRED' as const) : row.status,
  }));
}

/**
 * An action's state, for the person or for the agent that prepared it.
 *
 * Unlike deciding, reading is open to the agent — it needs to tell the person
 * whether what it prepared went through — but only for actions of the person
 * it acts for, in the organization it is bound to.
 */
export async function getActionStatus(ctx: TenantContext, actionId: string) {
  if (!isUserPrincipal(ctx.principal)) throw new NotFoundError('Agent action');
  const userId = ctx.principal.userId;
  const row = await withTenant(ctx, (db) =>
    db.agentAction.findFirst({
      where: { id: actionId, userId },
      select: { ...ACTION_SELECT, result: true },
    }),
  );
  if (!row) throw new NotFoundError('Agent action');
  const expired = row.status === 'PENDING' && row.expiresAt <= clock.now();
  return { ...row, status: expired ? ('EXPIRED' as const) : row.status };
}

export async function rejectAction(ctx: TenantContext, actionId: string) {
  const userId = personOf(ctx);
  const updated = await withTenant(ctx, (db) =>
    db.agentAction.updateMany({
      where: { id: actionId, userId, status: 'PENDING' },
      data: { status: 'REJECTED', decidedAt: clock.now() },
    }),
  );
  if (updated.count === 0) throw new NotFoundError('Agent action');
}

/**
 * Confirm and execute, exactly once.
 *
 * The PENDING → EXECUTING claim is one conditional update, so two clicks, two
 * tabs or a replayed request can run the call at most once. The grant is read
 * again — an MCP action from a grant revoked since it was prepared does not
 * run — and the route call runs as the person under that delegation, with
 * `confirmedActionId` set: the only way an agent's outward permission passes.
 */
export async function confirmAction(
  ctx: TenantContext,
  actionId: string,
  meta: { origin: string; forwardedFor?: string | null },
) {
  const userId = personOf(ctx);
  const now = clock.now();

  const action = await withTenant(ctx, async (db) => {
    const claimed = await db.agentAction.updateMany({
      where: { id: actionId, userId, status: 'PENDING', expiresAt: { gt: now } },
      data: { status: 'EXECUTING', decidedAt: now },
    });
    if (claimed.count === 0) return null;
    return db.agentAction.findFirst({
      where: { id: actionId, userId },
      select: { id: true, channel: true, grantId: true, request: true, requestHash: true },
    });
  });

  if (!action) {
    throw new ConflictError('Action is not pending', {
      userMessage:
        'This action was already decided, or it expired. Ask the assistant to prepare it again.',
    });
  }

  const finish = (data: { status: 'EXECUTED' | 'FAILED'; result?: unknown; error?: string }) =>
    withTenant(ctx, (db) =>
      db.agentAction.update({
        where: { id: action.id },
        data: {
          status: data.status,
          ...(data.result !== undefined ? { result: data.result as Prisma.InputJsonValue } : {}),
          error: data.error ?? null,
        },
      }),
    );

  if (!isActionRequest(action.request) || !signatureMatches(action.request, action.requestHash)) {
    logger.error('agent action failed its integrity check', {
      securityEvent: true,
      actionId: action.id,
      organizationId: ctx.organizationId,
    });
    await finish({ status: 'FAILED', error: 'This action could not be verified and was not run.' });
    throw new ConflictError('Agent action failed integrity check', {
      userMessage: 'This action could not be verified and was not run.',
    });
  }

  let scopes: readonly AgentScope[] = AGENT_SCOPES;
  if (action.channel === 'MCP') {
    const grant = await withTenant(ctx, (db) =>
      db.agentGrant.findFirst({
        where: { id: action.grantId ?? '', userId, revokedAt: null },
        select: { scopes: true },
      }),
    );
    if (!grant) {
      await finish({ status: 'FAILED', error: 'The AI app’s access was revoked.' });
      throw new ConflictError('Grant revoked', {
        userMessage: 'The AI app that prepared this no longer has access, so it was not run.',
      });
    }
    scopes = grant.scopes.filter((s): s is AgentScope =>
      (AGENT_SCOPES as readonly string[]).includes(s),
    );
  }

  const request = action.request;
  const invocation: AgentInvocation = {
    userId,
    organizationId: ctx.organizationId,
    delegation: {
      channel: action.channel,
      ...(action.grantId ? { grantId: action.grantId } : {}),
      scopes,
      confirmedActionId: action.id,
    },
  };

  try {
    const result = await runAsAgent(invocation, () =>
      routeCall({
        organizationId: ctx.organizationId,
        correlationId: ctx.correlationId,
        forwardedFor: meta.forwardedFor ?? null,
        userAgent: `SocialSquareAgent/1 (${action.channel}; confirmed)`,
        origin: meta.origin,
      }).send(request.route, request.method, request.params, {
        ...(request.body !== undefined ? { body: request.body } : {}),
        idempotencyKey: action.id,
      }),
    );
    await finish({ status: 'EXECUTED', result: result ?? null });
    return { status: 'EXECUTED' as const };
  } catch (error) {
    const message =
      error instanceof AgentToolError ? error.message : 'Something went wrong while running it.';
    await finish({ status: 'FAILED', error: message });
    if (!(error instanceof AgentToolError)) {
      logger.error('agent action execution failed', {
        actionId: action.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { status: 'FAILED' as const, error: message };
  }
}
