import { ZodError } from 'zod';
import { newCorrelationId, type AgentScope } from '@orbit/core';
import { logger } from '@orbit/observability';
import { takeToken } from '@orbit/queue';
import { runAsAgent, type AgentInvocation } from '@/server/agent-invocation';
import { AgentToolError, routeCall } from './dispatch';
import { prepareAction } from './actions';
import { AGENT_TOOLS } from './tools';
import type { AgentTool } from './types';

/**
 * Running an agent tool (D-109): the one entry point shared by the MCP server
 * and the Copilot.
 *
 * In order: the tool must exist **and** be within the caller's scopes (a tool
 * outside them is reported as unknown, not as forbidden); the arguments are
 * parsed by the route's own schema; the pace is limited; and the tool runs
 * inside the agent invocation, so every route it calls authenticates as the
 * person, narrowed to the delegation. Outward tools never run here — they are
 * stored as an action for the person to confirm.
 */

export type ToolOutcome =
  | { kind: 'result'; data: unknown; untrusted: boolean }
  | {
      kind: 'confirmation';
      action: { id: string; summary: string; expiresAt: string; confirmUrl: string };
    }
  | { kind: 'error'; code: string; message: string; retryable: boolean };

export interface ToolRunContext {
  invocation: AgentInvocation;
  /** Where the person confirms actions — the app's own origin. */
  origin: string;
  /** The organization's slug, for the confirmation link. */
  organizationSlug: string;
  forwardedFor?: string | null;
  correlationId?: string;
}

/** Fields an agent may never supply, at any depth of its arguments. */
const SERVER_DERIVED = new Set([
  'organizationId',
  'userId',
  'actorUserId',
  'isPlatformAdmin',
  'membershipStatus',
  'delegation',
  'confirmedActionId',
]);

/** Sixty calls a minute: well above a model working through a task, well below a loop. */
const CALLS_PER_MINUTE = { capacity: 60, refillWindowMs: 60_000 };

export function toolsFor(scopes: readonly AgentScope[]): AgentTool<never>[] {
  return AGENT_TOOLS.filter((tool) => scopes.includes(tool.scope));
}

export function findTool(
  name: string,
  scopes: readonly AgentScope[],
): AgentTool<never> | undefined {
  return toolsFor(scopes).find((tool) => tool.name === name);
}

function derivedFieldIn(value: unknown, depth = 0): string | null {
  if (depth > 6 || value === null || typeof value !== 'object') return null;
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (SERVER_DERIVED.has(key)) return key;
    const nested = derivedFieldIn(inner, depth + 1);
    if (nested) return nested;
  }
  return null;
}

export async function runTool(
  name: string,
  rawArgs: unknown,
  context: ToolRunContext,
): Promise<ToolOutcome> {
  const { invocation } = context;
  const correlationId = context.correlationId ?? newCorrelationId();
  const started = Date.now();
  const log = (outcome: string, extra: Record<string, unknown> = {}) =>
    logger.info('agent tool call', {
      tool: name,
      outcome,
      channel: invocation.delegation.channel,
      grantId: invocation.delegation.grantId,
      organizationId: invocation.organizationId,
      userId: invocation.userId,
      durationMs: Date.now() - started,
      correlationId,
      ...extra,
    });

  const tool = findTool(name, invocation.delegation.scopes);
  if (!tool) {
    log('unknown_tool');
    return {
      kind: 'error',
      code: 'NOT_FOUND',
      message: `There is no tool named ${name}.`,
      retryable: false,
    };
  }

  const derived = derivedFieldIn(rawArgs);
  if (derived) {
    logger.warn('agent arguments carried a server-derived field', {
      securityEvent: true,
      tool: name,
      field: derived,
      organizationId: invocation.organizationId,
      userId: invocation.userId,
    });
    return {
      kind: 'error',
      code: 'VALIDATION_ERROR',
      message: `“${derived}” is decided by Social Square and cannot be supplied.`,
      retryable: false,
    };
  }

  const parsed = tool.input.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    log('invalid_arguments');
    return {
      kind: 'error',
      code: 'VALIDATION_ERROR',
      message: parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
        .join('; '),
      retryable: false,
    };
  }

  const pace = await takeToken(
    `ratelimit:agent:${invocation.delegation.grantId ?? `copilot:${invocation.userId}`}`,
    CALLS_PER_MINUTE,
  ).catch(() => ({ allowed: true, retryAfterMs: 0 }));
  if (!pace.allowed) {
    log('rate_limited');
    return {
      kind: 'error',
      code: 'RATE_LIMITED',
      message: `Too many calls. Try again in ${Math.ceil(pace.retryAfterMs / 1_000)} seconds.`,
      retryable: true,
    };
  }

  const call = routeCall({
    organizationId: invocation.organizationId,
    correlationId,
    forwardedFor: context.forwardedFor ?? null,
    userAgent: `SocialSquareAgent/1 (${invocation.delegation.channel})`,
    origin: context.origin,
  });

  try {
    return await runAsAgent(invocation, async () => {
      if (tool.prepare) {
        const action = await prepareAction(
          invocation,
          tool.name,
          await tool.prepare(parsed.data, call),
          {
            origin: context.origin,
            organizationSlug: context.organizationSlug,
          },
        );
        log('confirmation_required', { actionId: action.id });
        return { kind: 'confirmation', action } as const;
      }
      if (!tool.run) throw new Error(`Tool ${tool.name} has neither run nor prepare`);

      const data = await tool.run(parsed.data, call);
      log('ok');
      return { kind: 'result', data, untrusted: Boolean(tool.untrustedOutput) } as const;
    });
  } catch (error) {
    if (error instanceof ZodError) {
      log('invalid_arguments');
      return {
        kind: 'error',
        code: 'VALIDATION_ERROR',
        message: error.issues.map((issue) => issue.message).join('; '),
        retryable: false,
      };
    }
    if (error instanceof AgentToolError) {
      log('route_error', { code: error.code, status: error.status });
      return {
        kind: 'error',
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      };
    }
    if (isSafeError(error)) {
      log('refused', { code: error.code });
      return { kind: 'error', code: error.code, message: error.userMessage, retryable: false };
    }
    logger.error('agent tool failed', {
      tool: name,
      correlationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      kind: 'error',
      code: 'INTERNAL_ERROR',
      message: `Something went wrong. Reference: ${correlationId}`,
      retryable: true,
    };
  }
}

/** An `AppError` from `@orbit/core` thrown by our own code: its `userMessage` is safe to show. */
function isSafeError(error: unknown): error is { code: string; userMessage: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { userMessage?: unknown }).userMessage === 'string'
  );
}
