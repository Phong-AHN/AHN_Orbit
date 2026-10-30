import {
  AGENT_SCOPES,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  clock,
  isUserPrincipal,
  type TenantContext,
} from '@orbit/core';
import type { AgentModel, AgentToolResult, AgentToolSpec } from '@orbit/ai';
import type { OrganizationSummary } from '@orbit/auth';
import { withTenant, type Prisma } from '@orbit/db';
import { logger } from '@orbit/observability';
import { canSomewhere } from '@orbit/rbac';
import { copilotModel } from '@/server/ai-provider';
import type { AgentInvocation } from '@/server/agent-invocation';
import { assertAIAllowance, recordAIUsage } from '@/features/ai/service';
import { agentEnabledFor } from '@/features/agent/availability';
import { toJsonSchema } from '@/features/agent/json-schema';
import { SERVER_INSTRUCTIONS, toolResult } from '@/features/agent/mcp';
import { runTool, toolsFor } from '@/features/agent/registry';

/**
 * The in-app Copilot (D-109 phase 5).
 *
 * The same tools as the MCP server, run in process through the same registry:
 * each tool call authenticates as the person who is typing, narrowed to a
 * Copilot delegation, so the Copilot can do exactly what that person could —
 * and outward actions come back as cards they confirm. What differs from MCP is
 * only who supplies the model: here it is ours, metered as one AI credit per
 * message (`copilotModel`, which during testing also allows the free tier).
 *
 * Threads belong to one person. Nobody else — an Owner included — can list or
 * read them, because they are a record of that person's work and of whatever
 * client data their tools returned.
 */

const MAX_STEPS = 8;
const MAX_CALLS_PER_STEP = 8;
/** Leaves headroom under the route's 60-second ceiling. */
const DEADLINE_MS = 50_000;
/** Turns of history replayed to the model; older ones stay visible, not sent. */
const HISTORY_TURNS = 10;
const MAX_TEXT = 4_000;
/** What one tool result may put in front of the model, and into the stored history. */
const MAX_RESULT_CHARS = 20_000;

export interface CopilotStepView {
  tool: string;
  ok: boolean;
  /** Set when the tool prepared an action for the person to confirm. */
  actionId?: string;
}

export interface CopilotActionView {
  id: string;
  summary: string;
  expiresAt: string;
}

export type CopilotMessage =
  | { role: 'user'; text: string; at: string }
  | {
      role: 'assistant';
      text: string;
      steps: CopilotStepView[];
      actions: CopilotActionView[];
      at: string;
    };

function personOf(ctx: TenantContext) {
  if (!isUserPrincipal(ctx.principal) || ctx.principal.delegation) {
    throw new NotFoundError('Copilot thread');
  }
  return ctx.principal;
}

export function copilotAvailability(organization: { id: string; slug: string }) {
  if (!agentEnabledFor(organization))
    return { available: false as const, reason: 'NOT_ENABLED' as const };
  if (!copilotModel()) return { available: false as const, reason: 'NO_MODEL' as const };
  return { available: true as const };
}

export async function listThreads(ctx: TenantContext) {
  const person = personOf(ctx);
  return withTenant(ctx, (db) =>
    db.agentThread.findMany({
      where: { userId: person.userId },
      select: { id: true, title: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    }),
  );
}

export async function getThread(ctx: TenantContext, threadId: string) {
  const person = personOf(ctx);
  const thread = await withTenant(ctx, (db) =>
    db.agentThread.findFirst({
      where: { id: threadId, userId: person.userId },
      select: { id: true, title: true, messages: true, updatedAt: true },
    }),
  );
  if (!thread) throw new NotFoundError('Copilot thread');
  return { ...thread, messages: thread.messages as unknown as CopilotMessage[] };
}

export async function deleteThread(ctx: TenantContext, threadId: string) {
  const person = personOf(ctx);
  const deleted = await withTenant(ctx, (db) =>
    db.agentThread.deleteMany({ where: { id: threadId, userId: person.userId } }),
  );
  if (deleted.count === 0) throw new NotFoundError('Copilot thread');
}

function toolSpecs(): AgentToolSpec[] {
  return toolsFor(AGENT_SCOPES).map((tool) => ({
    name: tool.name,
    description:
      tool.tier === 'W2'
        ? `${tool.description} This only prepares it: a confirmation card appears under your reply, and nothing happens until the user presses Confirm.`
        : tool.description,
    parameters: toJsonSchema(tool.input),
  }));
}

function systemPrompt(
  organization: OrganizationSummary,
  person: { name: string | null; role: string },
  now: Date,
): string {
  const date = new Intl.DateTimeFormat('en-GB', {
    timeZone: organization.timezone,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(now);
  return [
    SERVER_INSTRUCTIONS,
    '',
    `You are the Copilot inside Social Square. It is ${date} in the organization's time zone (${organization.timezone}).`,
    `You are working for ${person.name ?? 'the user'}, whose role is ${person.role}, in the organization "${organization.name}".`,
    'When a tool prepares an action, a confirmation card is shown under your reply in this chat: tell the user to read it and press Confirm there. Do not paste the confirmation link.',
    'Be concise. Use short paragraphs or lists.',
  ].join('\n');
}

/**
 * One message from the person, answered.
 *
 * The loop is bounded three ways — steps, calls per step, and wall-clock — so
 * a model that keeps calling tools ends with an honest "I stopped" rather than
 * a timeout. The credit check runs first, and the turn is metered once with
 * every model call's tokens, succeeded or not.
 */
export async function sendMessage(
  ctx: TenantContext,
  organization: OrganizationSummary,
  input: { threadId: string | null; text: string; user: { name: string | null } },
  meta: { origin: string; forwardedFor?: string | null },
  model: AgentModel | null = copilotModel(),
) {
  const person = personOf(ctx);
  if (!agentEnabledFor(organization)) throw new NotFoundError('Copilot');
  // Each message spends AI; the tools then check their own rights.
  if (!canSomewhere(ctx, 'ai:generate')) {
    throw new ForbiddenError('Permission denied: ai:generate', {
      userMessage: 'Your role does not include the AI Copilot.',
    });
  }
  if (!model) {
    throw new ConflictError('Copilot has no model configured', {
      userMessage:
        'The Copilot is not set up yet. You can still connect Claude or ChatGPT in Connected AI apps.',
    });
  }

  await assertAIAllowance(ctx);

  const text = input.text.trim().slice(0, MAX_TEXT);
  const existing = input.threadId
    ? await withTenant(ctx, (db) =>
        db.agentThread.findFirst({
          where: { id: input.threadId!, userId: person.userId },
          select: { id: true, messages: true, modelHistory: true },
        }),
      )
    : null;
  if (input.threadId && !existing) throw new NotFoundError('Copilot thread');

  const priorTurns = (existing?.modelHistory as unknown[][] | undefined) ?? [];
  const priorHistory = priorTurns.slice(-HISTORY_TURNS).flat();
  const turn: unknown[] = [model.userTurn(text)];

  const invocation: AgentInvocation = {
    userId: person.userId,
    organizationId: ctx.organizationId,
    delegation: { channel: 'COPILOT', scopes: AGENT_SCOPES },
  };
  const tools = toolSpecs();
  const system = systemPrompt(
    organization,
    { name: input.user.name, role: person.organizationRole },
    clock.now(),
  );

  const steps: CopilotStepView[] = [];
  const actions: CopilotActionView[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, latencyMs: 0 };
  const started = Date.now();
  let answer = '';
  let succeeded = false;

  try {
    for (let i = 0; i < MAX_STEPS; i += 1) {
      if (Date.now() - started > DEADLINE_MS) {
        answer = 'I stopped here because this was taking too long. Ask me to continue.';
        break;
      }
      const step = await model.step({ system, history: [...priorHistory, ...turn], tools });
      turn.push(...step.appended);
      usage.inputTokens += step.inputTokens;
      usage.outputTokens += step.outputTokens;
      usage.latencyMs += step.latencyMs;

      if (step.toolCalls.length === 0) {
        answer = step.text;
        break;
      }

      const results: AgentToolResult[] = [];
      for (const call of step.toolCalls.slice(0, MAX_CALLS_PER_STEP)) {
        const outcome = await runTool(call.name, call.args, {
          invocation,
          origin: meta.origin,
          organizationSlug: organization.slug,
          forwardedFor: meta.forwardedFor ?? null,
          correlationId: ctx.correlationId,
        });
        const rendered = toolResult(outcome);
        results.push({
          call,
          text: rendered.content[0]!.text.slice(0, MAX_RESULT_CHARS),
          isError: rendered.isError,
        });
        steps.push({
          tool: call.name,
          ok: outcome.kind !== 'error',
          ...(outcome.kind === 'confirmation' ? { actionId: outcome.action.id } : {}),
        });
        if (outcome.kind === 'confirmation') {
          actions.push({
            id: outcome.action.id,
            summary: outcome.action.summary,
            expiresAt: outcome.action.expiresAt,
          });
        }
      }
      turn.push(model.toolTurn(results));

      if (i === MAX_STEPS - 1) {
        answer =
          step.text || 'I stopped after several steps. Ask me to continue if there is more to do.';
      }
    }
    succeeded = true;
  } finally {
    await recordAIUsage(
      { ctx, brandId: null, operation: 'copilot', correlationId: ctx.correlationId },
      model,
      { ...usage, succeeded },
    );
  }

  if (!answer && actions.length > 0) answer = 'I prepared this for you to confirm below.';
  if (!answer) answer = 'Done.';

  const at = clock.now().toISOString();
  const added: CopilotMessage[] = [
    { role: 'user', text, at },
    { role: 'assistant', text: answer, steps, actions, at },
  ];
  const messages = [
    ...((existing?.messages as unknown as CopilotMessage[] | undefined) ?? []),
    ...added,
  ];
  const modelHistory = [...priorTurns, turn].slice(-HISTORY_TURNS);

  const thread = await withTenant(ctx, (db) =>
    existing
      ? db.agentThread.update({
          where: { id: existing.id },
          data: {
            messages: messages as unknown as Prisma.InputJsonValue,
            modelHistory: modelHistory as unknown as Prisma.InputJsonValue,
          },
          select: { id: true, title: true },
        })
      : db.agentThread.create({
          data: {
            organizationId: ctx.organizationId,
            userId: person.userId,
            title: text.slice(0, 80) || 'New conversation',
            messages: messages as unknown as Prisma.InputJsonValue,
            modelHistory: modelHistory as unknown as Prisma.InputJsonValue,
          },
          select: { id: true, title: true },
        }),
  );

  logger.info('copilot turn', {
    organizationId: ctx.organizationId,
    userId: person.userId,
    threadId: thread.id,
    steps: steps.length,
    actions: actions.length,
    durationMs: Date.now() - started,
  });

  return { thread, messages: added };
}
