import { serverEnv } from '@orbit/config';
import {
  autoReplyGate,
  clock,
  isStaffed,
  readStaffedHours,
  replyWindow,
  type TenantContext,
} from '@orbit/core';
import {
  DEFAULT_HOLDING_MESSAGE,
  createAIProvider,
  decideReply,
  isStopRequest,
  toBrandContext,
  withDisclosure,
  type AIProvider,
  type AssistantTurn,
} from '@orbit/ai';
import { withTenant, type TenantDb } from '@orbit/db';
import { notify } from '@orbit/notifications';
import { logger } from '@orbit/observability';
import { capabilitiesFor, getProvider } from '@orbit/providers';
import { LOCK_UNAVAILABLE, enqueue, withLock } from '@orbit/queue';
import { loadAccountCredential } from '../credentials.js';

/**
 * The AI assistant answering one conversation on its own (**D-108**).
 *
 * Everything that decides *whether* is in `autoReplyGate` (core) and
 * everything that decides *what* is in `decideReply` (@orbit/ai), both pure
 * and tested. This file gathers what they need, acts on what they decide, and
 * writes down what happened.
 *
 * ## Asked again just before sending
 *
 * The gate is checked when the job runs, which may be ten minutes after the
 * message arrived, and checked once more after the model has answered and
 * before anything is sent — a colleague who replied while the model was
 * thinking wins, and the assistant's answer is discarded.
 *
 * ## Anything unexpected hands over
 *
 * A model that is down, rate limited or over budget; a reply too long for the
 * platform; a send the platform refuses. Each of these escalates the
 * conversation to a person rather than retrying something that would reach a
 * customer late, or twice.
 */

let cachedProvider: AIProvider | undefined;
function aiProvider(): AIProvider {
  if (!cachedProvider) {
    const env = serverEnv();
    cachedProvider = createAIProvider({
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL,
      production: env.APP_ENV === 'production',
    });
  }
  return cachedProvider;
}

/** For tests: answer with this provider instead of the configured one. */
export function setAssistantProviderForTests(provider: AIProvider | undefined): void {
  cachedProvider = provider;
}

/** Pause between a customer's message and the assistant considering it, out of hours. */
export const BATCH_DELAY_MS = 30_000;

export type AssistantOutcome = 'REPLIED' | 'ESCALATED' | 'PAUSED' | 'DEFERRED' | 'SKIPPED';

async function loadState(ctx: TenantContext, conversationId: string) {
  return withTenant(ctx, async (db) => {
    const conversation = await db.socialConversation.findFirst({
      where: {
        id: conversationId,
        socialAccount: { deletedAt: null },
        brand: { deletedAt: null },
      },
      select: {
        id: true,
        workspaceId: true,
        brandId: true,
        socialAccountId: true,
        participantExternalId: true,
        lastInboundAt: true,
        lastHumanReplyAt: true,
        assistantPaused: true,
        needsHuman: true,
        assistantReplyCount: true,
        socialAccount: {
          select: {
            platform: true,
            accountType: true,
            externalId: true,
            displayName: true,
            status: true,
            scopes: true,
          },
        },
        workspace: { select: { timezone: true } },
        brand: {
          select: {
            name: true,
            voice: {
              select: {
                companyDescription: true,
                productsServices: true,
                targetAudience: true,
                brandVoice: true,
                tone: true,
                website: true,
                preferredTerms: true,
                bannedTerms: true,
                ctas: true,
                exampleContent: true,
              },
            },
            assistant: true,
          },
        },
      },
    });
    return conversation;
  });
}

type State = NonNullable<Awaited<ReturnType<typeof loadState>>>;

function gateFor(state: State, now: Date) {
  const settings = state.brand.assistant;
  const messaging = capabilitiesFor(
    state.socialAccount.platform,
    state.socialAccount.accountType,
  ).messaging;

  const window =
    messaging.supported && messaging.replyWindowHours
      ? replyWindow({
          lastInboundAt: state.lastInboundAt,
          now,
          // The standard window only: the assistant never uses Human Agent.
          rules: { standardHours: messaging.replyWindowHours },
        })
      : { state: 'CLOSED' as const, closesAt: null };

  return autoReplyGate({
    mode: settings?.mode ?? 'OFF',
    windowState: window.state,
    paused: state.assistantPaused,
    needsHuman: state.needsHuman,
    repliesSoFar: state.assistantReplyCount,
    maxReplies: settings?.maxRepliesPerConversation ?? 3,
    lastHumanReplyAt: state.lastHumanReplyAt,
    lastInboundAt: state.lastInboundAt ?? now,
    staffed: isStaffed(readStaffedHours(settings?.staffedHours), state.workspace.timezone, now),
    graceMinutes: settings?.graceMinutes ?? 10,
    now,
  });
}

/**
 * Schedule the assistant to consider a conversation, if its brand has it on.
 *
 * Called when a customer's message is written. The delay comes from the same
 * gate the job will ask: the grace period during staffed hours, a short
 * batching pause otherwise. Keyed by the message, so a retried webhook does not
 * schedule twice.
 */
export async function scheduleAssistant(input: {
  ctx: TenantContext;
  conversationId: string;
  messageExternalId: string;
  correlationId: string;
}): Promise<boolean> {
  const state = await loadState(input.ctx, input.conversationId);
  if (!state || state.brand.assistant?.mode !== 'AUTO') return false;

  const now = clock.now();
  const gate = gateFor(state, now);
  if (!gate.act && gate.reason !== 'GRACE') return false;

  const delay =
    !gate.act && gate.retryAt
      ? Math.max(BATCH_DELAY_MS, gate.retryAt.getTime() - now.getTime())
      : BATCH_DELAY_MS;

  await enqueue(
    'assistant',
    {
      organizationId: input.ctx.organizationId,
      correlationId: input.correlationId,
      conversationId: input.conversationId,
    },
    {
      jobId: `assistant-${input.conversationId}-${input.messageExternalId.slice(-60).replace(/[^A-Za-z0-9_-]/g, '')}`,
      delayMs: delay,
    },
  );
  return true;
}

/** Whether the organization has AI credits left this month. */
async function creditsLeft(ctx: TenantContext): Promise<boolean> {
  const now = clock.now();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  return withTenant(ctx, async (db) => {
    const [used, subscription] = await Promise.all([
      db.aIUsage.count({ where: { createdAt: { gte: periodStart } } }),
      db.subscription.findFirst({ select: { limits: true } }),
    ]);
    const limit = (subscription?.limits as { aiCreditsPerMonth?: number } | undefined)
      ?.aiCreditsPerMonth;
    return limit === undefined || used < limit;
  });
}

/** How long one conversation's assistant run may hold its lock. */
const CONVERSATION_LOCK_MS = 120_000;

/** When the lock is taken, how long before asking again. */
const LOCKED_RETRY_MS = 15_000;

/**
 * One conversation at a time.
 *
 * Every customer message schedules its own job, so two messages in a row — or
 * a backlog drained at once after an outage — run in parallel. Both then read
 * "not handed over yet" and both act: on 2026-10-29 a customer received the
 * holding message twice, seven seconds apart, and two replies were as likely.
 * The second job waits instead, and when it runs it reads what the first did
 * — the brand has spoken since, or the conversation is with a person — and
 * stays out.
 */
export async function runAssistant(input: {
  ctx: TenantContext;
  conversationId: string;
  correlationId: string;
}): Promise<AssistantOutcome> {
  const { ctx, conversationId } = input;

  const result = await withLock(`lock:assistant:${conversationId}`, CONVERSATION_LOCK_MS, () =>
    runAssistantLocked(input),
  );
  if (result !== LOCK_UNAVAILABLE) return result;

  await enqueue(
    'assistant',
    { organizationId: ctx.organizationId, correlationId: input.correlationId, conversationId },
    {
      jobId: `assistant-${conversationId}-locked-${clock.now().getTime()}`,
      delayMs: LOCKED_RETRY_MS,
    },
  );
  return 'DEFERRED';
}

async function runAssistantLocked(input: {
  ctx: TenantContext;
  conversationId: string;
  correlationId: string;
}): Promise<AssistantOutcome> {
  const { ctx, conversationId } = input;

  const state = await loadState(ctx, conversationId);
  if (!state || !state.brand.assistant) return 'SKIPPED';
  if (state.socialAccount.status !== 'ACTIVE') return 'SKIPPED';

  const now = clock.now();
  const gate = gateFor(state, now);

  if (!gate.act) {
    if (gate.reason === 'GRACE' && gate.retryAt) {
      // Still inside the grace period — a later message moved it. Ask again then.
      await enqueue(
        'assistant',
        { organizationId: ctx.organizationId, correlationId: input.correlationId, conversationId },
        {
          jobId: `assistant-${conversationId}-retry-${gate.retryAt.getTime()}`,
          delayMs: Math.max(1_000, gate.retryAt.getTime() - now.getTime()),
        },
      );
      return 'DEFERRED';
    }
    return 'SKIPPED';
  }

  const recent = await withTenant(ctx, (db) =>
    db.socialMessage.findMany({
      where: { conversationId },
      select: { direction: true, text: true, deletedAt: true, sentAt: true },
      orderBy: { sentAt: 'desc' },
      take: 10,
    }),
  );
  const ordered = recent.reverse();

  // The brand has already spoken since the customer did: an earlier job, a
  // colleague, or the platform's app. Nothing is waiting.
  if (ordered.at(-1)?.direction !== 'INBOUND') return 'SKIPPED';

  const turns: AssistantTurn[] = ordered
    .filter((message) => message.text && !message.deletedAt)
    .map((message) => ({
      from: message.direction === 'INBOUND' ? 'CUSTOMER' : 'BRAND',
      text: message.text as string,
    }));

  const latest = turns.at(-1);
  if (latest?.from === 'CUSTOMER' && isStopRequest(latest.text)) {
    await escalate(ctx, state, {
      category: 'HUMAN_REQUESTED',
      reason: 'the customer asked the assistant to stop',
      pause: true,
      // They asked for silence; a holding message would be the opposite.
      hold: false,
    });
    return 'PAUSED';
  }

  if (!(await creditsLeft(ctx))) {
    await escalate(ctx, state, {
      category: 'MODEL_UNAVAILABLE',
      reason: 'the organization has no AI credits left this month',
    });
    return 'ESCALATED';
  }

  const entries = await withTenant(ctx, (db) =>
    db.brandKnowledgeEntry.findMany({
      // Internal notes never reach the model.
      where: { brandId: state.brandId, usableByAssistant: true },
      select: { id: true, title: true, question: true, content: true },
      orderBy: { updatedAt: 'desc' },
    }),
  );

  const messaging = capabilitiesFor(
    state.socialAccount.platform,
    state.socialAccount.accountType,
  ).messaging;
  // Room for the disclosure, which is always appended.
  const room = (messaging.maxMessageLength ?? 1_000) - withDisclosure('').length;

  const provider = aiProvider();
  const decision = await decideReply(provider, {
    brand: toBrandContext(state.brand.name, state.brand.voice),
    brandName: state.brand.name,
    entries: entries.map((entry) => ({
      id: entry.id,
      title: entry.title,
      ...(entry.question ? { question: entry.question } : {}),
      content: entry.content,
    })),
    turns,
    correlationId: input.correlationId,
    extraEscalationTerms: state.brand.assistant.escalationTerms,
    maxLength: room,
  });

  if (decision.usage || decision.failed) {
    await recordUsage(ctx, state.brandId, provider.model, decision);
  }

  if (decision.verdict.action === 'ESCALATE') {
    await escalate(ctx, state, {
      category: decision.verdict.category,
      reason: decision.verdict.reason,
      usage: decision.usage,
    });
    return 'ESCALATED';
  }

  const text = withDisclosure(decision.verdict.reply);
  if (messaging.maxMessageBytes && Buffer.byteLength(text, 'utf8') > messaging.maxMessageBytes) {
    await escalate(ctx, state, {
      category: 'UNSAFE_ANSWER',
      reason: 'the answer was too long for the platform',
      usage: decision.usage,
    });
    return 'ESCALATED';
  }

  // Once more, now that the model has taken its time: a colleague who answered
  // meanwhile wins.
  const fresh = await loadState(ctx, conversationId);
  if (!fresh || !gateFor(fresh, clock.now()).act) return 'SKIPPED';

  const sent = await send(ctx, state, text);
  if (!sent) {
    await escalate(ctx, state, {
      category: 'MODEL_UNAVAILABLE',
      reason: 'the platform refused the automatic reply',
      usage: decision.usage,
      // The platform has just refused one message; a second is no likelier to
      // arrive, and the first may have arrived unconfirmed.
      hold: false,
    });
    return 'ESCALATED';
  }

  await withTenant(ctx, async (db) => {
    await recordSent(db, ctx, state, sent, text, fresh.lastHumanReplyAt);
    await db.socialConversation.update({
      where: { id: conversationId },
      data: {
        assistantReplyCount: { increment: 1 },
        // Answered, so not waiting — but visibly by the assistant, in the
        // decision log and on the message itself.
        state: 'HANDLED',
        handledAt: clock.now(),
        handledById: null,
      },
    });
    await db.assistantDecision.create({
      data: {
        organizationId: ctx.organizationId,
        conversationId,
        action: 'REPLIED',
        text: decision.verdict.action === 'REPLY' ? decision.verdict.reply : null,
        citedEntryIds: decision.verdict.action === 'REPLY' ? decision.verdict.citedEntryIds : [],
        ...usageColumns(decision.usage),
      },
    });
  });

  logger.info('assistant replied to a private message', {
    conversationId,
    platform: state.socialAccount.platform,
    socialAccountId: state.socialAccountId,
  });
  return 'REPLIED';
}

// ── Internals ───────────────────────────────────────────────────────────────

function usageColumns(
  usage:
    { model: string; inputTokens: number; outputTokens: number; latencyMs: number } | undefined,
) {
  return usage
    ? {
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        latencyMs: usage.latencyMs,
      }
    : {};
}

/** Every model call is metered, failed ones included — they were spent. */
async function recordUsage(
  ctx: TenantContext,
  brandId: string,
  model: string,
  decision: Awaited<ReturnType<typeof decideReply>>,
): Promise<void> {
  try {
    await withTenant(ctx, (db) =>
      db.aIUsage.create({
        data: {
          organizationId: ctx.organizationId,
          createdAt: clock.now(),
          brandId,
          operation: 'message.assistant',
          model,
          inputTokens: decision.usage?.inputTokens ?? 0,
          outputTokens: decision.usage?.outputTokens ?? 0,
          latencyMs: decision.usage?.latencyMs ?? null,
          succeeded: !decision.failed,
        },
      }),
    );
  } catch (error) {
    logger.error('could not record assistant AI usage', {
      organizationId: ctx.organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Send through the platform. Null when it refused. */
async function send(
  ctx: TenantContext,
  state: State,
  text: string,
): Promise<{ externalId: string; sentAt: Date } | null> {
  const provider = getProvider(state.socialAccount.platform);
  if (!provider.sendMessage) return null;

  try {
    const credential = await loadAccountCredential(ctx, state.socialAccountId);
    return await provider.sendMessage({
      credential,
      account: { externalId: state.socialAccount.externalId },
      recipientExternalId: state.participantExternalId,
      text,
      // Never: the Human Agent tag is for a person typing.
      humanAgent: false,
    });
  } catch (error) {
    logger.warn('the platform refused an assistant message', {
      conversationId: state.id,
      reason: (error as { code?: string }).code ?? 'unknown',
    });
    return null;
  }
}

/**
 * Write what the assistant sent.
 *
 * The platform echoes every message back by webhook, and the echo may be
 * processed before this runs — in which case the row already exists, written
 * as a message from the brand's own app, and the echo will have marked a
 * person as having just replied. Both are corrected here: the row is marked as
 * the assistant's and the conversation's last human reply restored.
 */
async function recordSent(
  db: TenantDb,
  ctx: TenantContext,
  state: State,
  sent: { externalId: string; sentAt: Date },
  text: string,
  lastHumanReplyAt: Date | null,
): Promise<void> {
  const existing = await db.socialMessage.findFirst({
    where: { socialAccountId: state.socialAccountId, externalId: sent.externalId },
    select: { id: true },
  });

  if (existing) {
    await db.socialMessage.update({ where: { id: existing.id }, data: { sentByAssistant: true } });
  } else {
    await db.socialMessage.create({
      data: {
        organizationId: ctx.organizationId,
        conversationId: state.id,
        socialAccountId: state.socialAccountId,
        externalId: sent.externalId,
        direction: 'OUTBOUND',
        text,
        sentAt: sent.sentAt,
        sentByAssistant: true,
      },
    });
  }

  await db.socialConversation.update({
    where: { id: state.id },
    data: { lastMessageAt: sent.sentAt, lastHumanReplyAt },
  });
}

/**
 * Hand the conversation to a person.
 *
 * Marked as needing a human, so the assistant stays out and the inbox shows
 * why; the customer told once that somebody will reply; staff notified. The
 * holding message is sent only the first time — a conversation already handed
 * over is not handed over again.
 */
async function escalate(
  ctx: TenantContext,
  state: State,
  input: {
    category: string;
    reason: string;
    pause?: boolean;
    hold?: boolean;
    usage?:
      { model: string; inputTokens: number; outputTokens: number; latencyMs: number } | undefined;
  },
): Promise<void> {
  // A colleague may have answered while the model was thinking. Then the
  // conversation is theirs: nothing is sent, nothing they did is undone, and
  // only the decision is written down.
  const fresh = await loadState(ctx, state.id);
  const stillOurs = Boolean(fresh && gateFor(fresh, clock.now()).act);

  const firstTime = stillOurs && !state.needsHuman;
  let held: { externalId: string; sentAt: Date } | null = null;
  let holdingText: string | null = null;

  if (firstTime && input.hold !== false) {
    holdingText = withDisclosure(state.brand.assistant?.holdingMessage || DEFAULT_HOLDING_MESSAGE);
    held = await send(ctx, state, holdingText);
  }

  await withTenant(ctx, async (db) => {
    if (held && holdingText) {
      await recordSent(db, ctx, state, held, holdingText, fresh?.lastHumanReplyAt ?? null);
    }

    if (stillOurs || input.pause) {
      await db.socialConversation.update({
        where: { id: state.id },
        data: {
          // The customer asked for the assistant to stop: kept whoever answered.
          ...(input.pause ? { assistantPaused: true } : {}),
          ...(stillOurs
            ? {
                needsHuman: true,
                escalationReason: input.reason.slice(0, 300),
                // Waiting on a person, whatever it was before.
                state: 'NEW' as const,
                handledAt: null,
                handledById: null,
              }
            : {}),
        },
      });
    }

    await db.assistantDecision.create({
      data: {
        organizationId: ctx.organizationId,
        conversationId: state.id,
        action: 'ESCALATED',
        category: input.category,
        reason: input.reason.slice(0, 300),
        ...(holdingText && held ? { text: holdingText } : {}),
        ...usageColumns(input.usage),
      },
    });

    if (firstTime) {
      await notify(db, ctx, {
        event: {
          type: 'message.needs_human',
          accountName: state.socialAccount.displayName,
          // The kind of matter, never the customer's words.
          reason: input.category.toLowerCase().replaceAll('_', ' '),
        },
        resource: {
          resourceType: 'SocialConversation',
          resourceId: state.id,
          workspaceId: state.workspaceId,
          brandId: state.brandId,
        },
      });
    }
  });

  logger.info('assistant handed a conversation to a person', {
    conversationId: state.id,
    category: input.category,
  });
}
