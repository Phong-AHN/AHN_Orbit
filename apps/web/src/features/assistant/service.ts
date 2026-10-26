import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  actorUserId,
  clock,
  isUserPrincipal,
  readStaffedHours,
  type TenantContext,
} from '@orbit/core';
import { serverEnv } from '@orbit/config';
import { withTenant, type TenantDb } from '@orbit/db';
import {
  AI_DISCLOSURE,
  DEFAULT_HOLDING_MESSAGE,
  MAX_KNOWLEDGE_CHARS,
  decideReply,
  toBrandContext,
  withDisclosure,
  type AssistantTurn,
  type Decision,
} from '@orbit/ai';
import { logger } from '@orbit/observability';
import { capabilitiesFor } from '@orbit/providers';
import { assertCan, can } from '@orbit/rbac';
import { audit, type AuditInput } from '@/server/audit';
import { aiProvider } from '@/server/ai-provider';
import { assertAIAllowance, recordAIUsage } from '@/features/ai/service';
import {
  MAX_ENTRIES_PER_BRAND,
  type AssistantSettingsInput,
  type KnowledgeEntryInput,
  type KnowledgeEntryUpdate,
} from './contracts';

/**
 * The AI assistant, as the agency configures and supervises it (**D-108**).
 *
 * The worker sends; this file never does. What it holds is everything a person
 * decides: what the assistant may answer from, when it may answer alone, and
 * what a colleague thinks of what it said. Suggestions — a draft a colleague
 * reads, edits and sends themselves — are made here, because a person is in
 * the loop and waiting for them.
 *
 * ## Who decides what
 *
 * - `ai_assistant:manage` edits a brand's knowledge and settings. Owner and
 *   Admin hold it organization-wide; an Account Manager in their workspaces.
 * - **Switching on AUTO is organization-level only**: an Owner or Admin, after
 *   at least seven days of suggestions, with at least one document. Letting
 *   software answer a client's customers alone is the agency's decision, and
 *   the seven days are how it gets to see what that software would say.
 * - Suggestions, ratings and pausing one conversation are part of answering
 *   messages, so they need `message:reply` on that conversation's brand.
 */

/** Days of suggestions before the assistant may answer on its own. */
export const SUGGEST_DAYS_BEFORE_AUTO = 7;

const DAY_MS = 24 * 60 * 60 * 1_000;

const ENTRY_SELECT = {
  id: true,
  kind: true,
  title: true,
  question: true,
  content: true,
  usableByAssistant: true,
  updatedAt: true,
  updatedBy: { select: { id: true, name: true } },
} as const;

const SETTINGS_SELECT = {
  id: true,
  mode: true,
  staffedHours: true,
  graceMinutes: true,
  holdingMessage: true,
  maxRepliesPerConversation: true,
  escalationTerms: true,
  suggestSince: true,
  updatedAt: true,
} as const;

/** What a brand with no settings row behaves as. Off, until someone says otherwise. */
const DEFAULT_SETTINGS = {
  id: null,
  mode: 'OFF' as const,
  staffedHours: [],
  graceMinutes: 10,
  holdingMessage: null,
  maxRepliesPerConversation: 3,
  escalationTerms: [] as string[],
  suggestSince: null,
  updatedAt: null,
};

// ── The brand's assistant ───────────────────────────────────────────────────

/**
 * Everything the settings page shows: the settings, the knowledge, how the
 * assistant has done lately, and whether AUTO may be switched on — with the
 * reasons when it may not, so the page can say what is missing.
 */
export async function getAssistant(ctx: TenantContext, brandId: string) {
  const brand = await requireBrand(ctx, brandId);
  const since = new Date(clock.now().getTime() - 30 * DAY_MS);

  const [settings, entries, decisions] = await withTenant(ctx, (db) =>
    Promise.all([
      db.brandAssistant.findFirst({ where: { brandId }, select: SETTINGS_SELECT }),
      db.brandKnowledgeEntry.findMany({
        where: { brandId },
        select: ENTRY_SELECT,
        orderBy: [{ kind: 'asc' }, { title: 'asc' }],
      }),
      db.assistantDecision.groupBy({
        by: ['action'],
        where: { createdAt: { gte: since }, conversation: { brandId } },
        _count: { _all: true },
      }),
    ]),
  );

  const ratings = await withTenant(ctx, (db) =>
    db.assistantDecision.groupBy({
      by: ['rating'],
      where: { createdAt: { gte: since }, conversation: { brandId }, rating: { not: null } },
      _count: { _all: true },
    }),
  );

  const current = settings
    ? { ...settings, staffedHours: readStaffedHours(settings.staffedHours) }
    : DEFAULT_SETTINGS;

  const knowledgeChars = usableChars(entries);

  return {
    brand,
    settings: current,
    entries,
    knowledgeChars,
    maxKnowledgeChars: MAX_KNOWLEDGE_CHARS,
    stats: {
      suggested: countOf(decisions, 'SUGGESTED'),
      replied: countOf(decisions, 'REPLIED'),
      escalated: countOf(decisions, 'ESCALATED'),
      ratedGood: ratings.find((row) => row.rating === true)?._count._all ?? 0,
      ratedBad: ratings.find((row) => row.rating === false)?._count._all ?? 0,
    },
    auto: autoReadiness(ctx, current, entries),
    // The free tier lets Google use what is sent to improve its products. The
    // page says so, plainly, beside every switch that sends customer messages.
    freeTier: serverEnv().GEMINI_TIER === 'free',
    disclosure: AI_DISCLOSURE,
    defaultHoldingMessage: DEFAULT_HOLDING_MESSAGE,
  };
}

export type AssistantOverview = Awaited<ReturnType<typeof getAssistant>>;

export async function updateAssistantSettings(
  ctx: TenantContext,
  brandId: string,
  input: AssistantSettingsInput,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  const brand = await requireBrand(ctx, brandId);
  const now = clock.now();

  return withTenant(ctx, async (db) => {
    const existing = await db.brandAssistant.findFirst({
      where: { brandId },
      select: { id: true, mode: true, suggestSince: true },
    });

    if (input.mode === 'AUTO' && existing?.mode !== 'AUTO') {
      const entries = await db.brandKnowledgeEntry.findMany({
        where: { brandId },
        select: { usableByAssistant: true, content: true, title: true, question: true },
      });
      const readiness = autoReadiness(ctx, existing ?? DEFAULT_SETTINGS, entries);
      if (!readiness.allowed) {
        throw new ConflictError('The assistant cannot answer on its own yet', {
          userMessage: readiness.reasons.join(' '),
        });
      }
    }

    // The seven days start the first time suggestions are on, and are not
    // reset by switching off and on again: what was seen was seen.
    const suggestSince = existing?.suggestSince ?? (input.mode !== 'OFF' ? now : null);

    const data = {
      mode: input.mode,
      staffedHours: input.staffedHours,
      graceMinutes: input.graceMinutes,
      holdingMessage: input.holdingMessage ? input.holdingMessage : null,
      maxRepliesPerConversation: input.maxRepliesPerConversation,
      escalationTerms: [...new Set(input.escalationTerms)],
      suggestSince,
      updatedById: actorUserId(ctx),
    };

    // Find-then-write: the scoped client refuses `upsert`.
    const saved = existing
      ? await db.brandAssistant.update({
          where: { id: existing.id },
          data,
          select: SETTINGS_SELECT,
        })
      : await db.brandAssistant.create({
          data: {
            organizationId: ctx.organizationId,
            workspaceId: brand.workspaceId,
            brandId,
            ...data,
          },
          select: SETTINGS_SELECT,
        });

    await audit(db, ctx, {
      action: 'brand_assistant.updated',
      resourceType: 'BrandAssistant',
      resourceId: saved.id,
      workspaceId: brand.workspaceId,
      brandId,
      before: { mode: existing?.mode ?? 'OFF' },
      after: {
        mode: saved.mode,
        graceMinutes: saved.graceMinutes,
        maxRepliesPerConversation: saved.maxRepliesPerConversation,
        staffedPeriods: input.staffedHours.length,
        escalationTerms: saved.escalationTerms.length,
      },
      ...fingerprint,
    });

    return { ...saved, staffedHours: readStaffedHours(saved.staffedHours) };
  });
}

// ── Knowledge ───────────────────────────────────────────────────────────────

export async function createKnowledgeEntry(
  ctx: TenantContext,
  brandId: string,
  input: KnowledgeEntryInput,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  const brand = await requireBrand(ctx, brandId);

  return withTenant(ctx, async (db) => {
    const entries = await db.brandKnowledgeEntry.findMany({
      where: { brandId },
      select: { id: true, usableByAssistant: true, content: true, title: true, question: true },
    });

    if (entries.length >= MAX_ENTRIES_PER_BRAND) {
      throw new ConflictError('Too many knowledge entries', {
        userMessage: `A brand can have up to ${MAX_ENTRIES_PER_BRAND} entries. Combine or remove some first.`,
      });
    }

    const usable = input.usableByAssistant ?? true;
    assertWithinBudget([...entries, { usableByAssistant: usable, ...normalizeEntry(input) }]);

    const created = await db.brandKnowledgeEntry.create({
      data: {
        organizationId: ctx.organizationId,
        workspaceId: brand.workspaceId,
        brandId,
        ...normalizeEntry(input),
        kind: input.kind,
        usableByAssistant: usable,
        updatedById: actorUserId(ctx),
      },
      select: ENTRY_SELECT,
    });

    await audit(db, ctx, {
      action: 'knowledge_entry.created',
      resourceType: 'BrandKnowledgeEntry',
      resourceId: created.id,
      workspaceId: brand.workspaceId,
      brandId,
      // The title, never the content: the content is the client's business.
      after: { kind: created.kind, title: created.title, usableByAssistant: usable },
      ...fingerprint,
    });

    return created;
  });
}

export async function updateKnowledgeEntry(
  ctx: TenantContext,
  brandId: string,
  entryId: string,
  input: KnowledgeEntryUpdate,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  const brand = await requireBrand(ctx, brandId);

  return withTenant(ctx, async (db) => {
    const entries = await db.brandKnowledgeEntry.findMany({
      where: { brandId },
      select: {
        id: true,
        kind: true,
        usableByAssistant: true,
        content: true,
        title: true,
        question: true,
      },
    });

    const existing = entries.find((entry) => entry.id === entryId);
    if (!existing) throw new NotFoundError('Knowledge entry');

    const next = {
      kind: input.kind ?? existing.kind,
      title: input.title ?? existing.title,
      question: input.question !== undefined ? input.question || null : existing.question,
      content: input.content ?? existing.content,
      usableByAssistant: input.usableByAssistant ?? existing.usableByAssistant,
    };

    assertWithinBudget(entries.map((entry) => (entry.id === entryId ? next : entry)));

    const updated = await db.brandKnowledgeEntry.update({
      where: { id: entryId },
      data: { ...next, updatedById: actorUserId(ctx) },
      select: ENTRY_SELECT,
    });

    await audit(db, ctx, {
      action: 'knowledge_entry.updated',
      resourceType: 'BrandKnowledgeEntry',
      resourceId: entryId,
      workspaceId: brand.workspaceId,
      brandId,
      after: { fields: Object.keys(input).sort(), usableByAssistant: next.usableByAssistant },
      ...fingerprint,
    });

    return updated;
  });
}

export async function deleteKnowledgeEntry(
  ctx: TenantContext,
  brandId: string,
  entryId: string,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  const brand = await requireBrand(ctx, brandId);

  await withTenant(ctx, async (db) => {
    const existing = await db.brandKnowledgeEntry.findFirst({
      where: { id: entryId, brandId },
      select: { id: true, title: true },
    });
    if (!existing) throw new NotFoundError('Knowledge entry');

    await db.brandKnowledgeEntry.delete({ where: { id: entryId } });

    await audit(db, ctx, {
      action: 'knowledge_entry.deleted',
      resourceType: 'BrandKnowledgeEntry',
      resourceId: entryId,
      workspaceId: brand.workspaceId,
      brandId,
      before: { title: existing.title },
      ...fingerprint,
    });
  });
}

/**
 * Ask the assistant a question, as a customer would, without anyone receiving
 * the answer. What the settings page uses to check the documents say what the
 * agency thinks they say. Costs a credit when the model is asked.
 */
export async function testAssistant(ctx: TenantContext, brandId: string, text: string) {
  const brand = await requireBrand(ctx, brandId);
  await assertAIAllowance(ctx);

  const { decision, entries } = await decide(ctx, {
    brandId,
    brandName: brand.name,
    turns: [{ from: 'CUSTOMER', text }],
    maxLength: 1_000 - withDisclosure('').length,
    operation: 'message.assistant_test',
  });

  return present(decision, entries, { disclose: true });
}

// ── In a conversation ───────────────────────────────────────────────────────

/**
 * Draft an answer for a colleague to read, edit and send.
 *
 * Nothing is sent and nothing about the conversation changes: an escalation
 * here is advice ("this one is for a person") and does not hand anything over.
 * The draft and the decision are recorded, so the seven days before AUTO are
 * seven days of evidence.
 */
export async function suggestReply(ctx: TenantContext, conversationId: string) {
  const conversation = await requireConversation(ctx, conversationId, 'message:reply');

  const settings = await withTenant(ctx, (db) =>
    db.brandAssistant.findFirst({
      where: { brandId: conversation.brandId },
      select: { mode: true },
    }),
  );
  if (!settings || settings.mode === 'OFF') {
    throw new ConflictError('The assistant is off for this brand', {
      userMessage:
        'AI suggestions are switched off for this brand. An admin can turn them on in the brand’s settings.',
    });
  }

  await assertAIAllowance(ctx);

  const turns = await recentTurns(ctx, conversationId);
  const messaging = capabilitiesFor(
    conversation.socialAccount.platform,
    conversation.socialAccount.accountType,
  ).messaging;

  const { decision, entries } = await decide(ctx, {
    brandId: conversation.brandId,
    brandName: conversation.brand.name,
    turns,
    maxLength: messaging.maxMessageLength ?? 1_000,
    operation: 'message.suggest',
  });

  const recorded = await withTenant(ctx, (db) =>
    db.assistantDecision.create({
      data: {
        organizationId: ctx.organizationId,
        conversationId,
        action: decision.verdict.action === 'REPLY' ? 'SUGGESTED' : 'ESCALATED',
        ...(decision.verdict.action === 'REPLY'
          ? { text: decision.verdict.reply, citedEntryIds: decision.verdict.citedEntryIds }
          : {
              category: decision.verdict.category,
              reason: decision.verdict.reason.slice(0, 300),
            }),
        ...(decision.usage
          ? {
              model: decision.usage.model,
              inputTokens: decision.usage.inputTokens,
              outputTokens: decision.usage.outputTokens,
              latencyMs: decision.usage.latencyMs,
            }
          : {}),
      },
      select: { id: true },
    }),
  );

  return { decisionId: recorded.id, ...present(decision, entries, { disclose: false }) };
}

/** What the assistant has done in one conversation, newest first. */
export async function listDecisions(ctx: TenantContext, conversationId: string) {
  await requireConversation(ctx, conversationId, 'message:read');

  const decisions = await withTenant(ctx, (db) =>
    db.assistantDecision.findMany({
      where: { conversationId },
      select: {
        id: true,
        action: true,
        category: true,
        reason: true,
        text: true,
        citedEntryIds: true,
        rating: true,
        createdAt: true,
        reviewedBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
  );

  const citedIds = [...new Set(decisions.flatMap((decision) => decision.citedEntryIds))];
  const titles = citedIds.length
    ? await withTenant(ctx, (db) =>
        db.brandKnowledgeEntry.findMany({
          where: { id: { in: citedIds } },
          select: { id: true, title: true },
        }),
      )
    : [];
  const titleOf = new Map(titles.map((entry) => [entry.id, entry.title]));

  return decisions.map(({ citedEntryIds, ...decision }) => ({
    ...decision,
    // An entry deleted since is simply not named.
    cited: citedEntryIds.flatMap((id) => {
      const title = titleOf.get(id);
      return title ? [{ id, title }] : [];
    }),
  }));
}

export type AssistantDecisionView = Awaited<ReturnType<typeof listDecisions>>[number];

/** A colleague's verdict on something the assistant said. */
export async function rateDecision(
  ctx: TenantContext,
  conversationId: string,
  decisionId: string,
  rating: boolean,
) {
  await requireConversation(ctx, conversationId, 'message:reply');

  return withTenant(ctx, async (db) => {
    const decision = await db.assistantDecision.findFirst({
      where: { id: decisionId, conversationId },
      select: { id: true },
    });
    if (!decision) throw new NotFoundError('Assistant decision');

    return db.assistantDecision.update({
      where: { id: decisionId },
      data: { rating, reviewedById: actorUserId(ctx) },
      select: { id: true, rating: true },
    });
  });
}

/** Keep the assistant out of one conversation, or let it back in. */
export async function setConversationAssistantPaused(
  ctx: TenantContext,
  conversationId: string,
  paused: boolean,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  const conversation = await requireConversation(ctx, conversationId, 'message:reply');

  return withTenant(ctx, async (db) => {
    const updated = await db.socialConversation.update({
      where: { id: conversationId },
      data: { assistantPaused: paused },
      select: { id: true, assistantPaused: true },
    });

    await audit(db, ctx, {
      action: paused
        ? 'social_conversation.assistant_paused'
        : 'social_conversation.assistant_resumed',
      resourceType: 'SocialConversation',
      resourceId: conversationId,
      workspaceId: conversation.workspaceId,
      brandId: conversation.brandId,
      ...fingerprint,
    });

    return updated;
  });
}

/** Whether the brand's assistant is on at all — for the conversation page's buttons. */
export async function assistantModeFor(ctx: TenantContext, brandId: string) {
  const settings = await withTenant(ctx, (db) =>
    db.brandAssistant.findFirst({ where: { brandId }, select: { mode: true } }),
  );
  return settings?.mode ?? 'OFF';
}

// ── Internals ───────────────────────────────────────────────────────────────

type EntryForBudget = {
  usableByAssistant: boolean;
  title: string;
  question: string | null;
  content: string;
};

function usableChars(entries: readonly EntryForBudget[]): number {
  return entries
    .filter((entry) => entry.usableByAssistant)
    .reduce(
      (sum, entry) =>
        sum + entry.title.length + (entry.question?.length ?? 0) + entry.content.length,
      0,
    );
}

/**
 * The knowledge the assistant reads must fit in its prompt whole. Refused when
 * it would not, rather than silently cut — a cut document is one the assistant
 * answers from without its last paragraph.
 */
function assertWithinBudget(entries: readonly EntryForBudget[]): void {
  const used = usableChars(entries);
  if (used > MAX_KNOWLEDGE_CHARS) {
    throw new ConflictError('The knowledge base is too long', {
      userMessage: `The documents the assistant reads can total ${MAX_KNOWLEDGE_CHARS.toLocaleString()} characters; this would make ${used.toLocaleString()}. Shorten an entry, or mark one as an internal note.`,
    });
  }
}

function normalizeEntry(input: KnowledgeEntryInput) {
  return {
    title: input.title,
    question: input.question ? input.question : null,
    content: input.content,
  };
}

function countOf(rows: { action: string; _count: { _all: number } }[], action: string): number {
  return rows.find((row) => row.action === action)?._count._all ?? 0;
}

/**
 * Whether AUTO may be switched on, and if not, every reason why. Asked of the
 * person, not just the brand: only an organization-wide grant may do it.
 */
function autoReadiness(
  ctx: TenantContext,
  settings: { mode: string; suggestSince: Date | null },
  entries: readonly EntryForBudget[],
): { allowed: boolean; reasons: string[]; daysLeft: number } {
  const reasons: string[] = [];
  const now = clock.now();

  if (!can(ctx, 'ai_assistant:manage', {})) {
    reasons.push(
      'Only an owner or admin of the organization can let the assistant answer on its own.',
    );
  }

  const elapsed = settings.suggestSince ? now.getTime() - settings.suggestSince.getTime() : 0;
  const daysLeft = settings.suggestSince
    ? Math.max(0, Math.ceil((SUGGEST_DAYS_BEFORE_AUTO * DAY_MS - elapsed) / DAY_MS))
    : SUGGEST_DAYS_BEFORE_AUTO;
  if (daysLeft > 0) {
    reasons.push(
      settings.suggestSince
        ? `Use suggestions for ${daysLeft} more day${daysLeft === 1 ? '' : 's'} first, so the team can see what the assistant would say.`
        : `Turn on suggestions first and use them for ${SUGGEST_DAYS_BEFORE_AUTO} days, so the team can see what the assistant would say.`,
    );
  }

  if (!entries.some((entry) => entry.usableByAssistant)) {
    reasons.push('Add at least one document or FAQ the assistant may answer from.');
  }

  return { allowed: reasons.length === 0, reasons, daysLeft };
}

/** Load the brand and authorize `ai_assistant:manage` against it. */
async function requireBrand(ctx: TenantContext, brandId: string) {
  requireUser(ctx);

  const brand = await withTenant(ctx, (db) =>
    db.brand.findFirst({
      where: { id: brandId, deletedAt: null },
      select: {
        id: true,
        name: true,
        workspaceId: true,
        workspace: { select: { id: true, name: true, timezone: true } },
      },
    }),
  );
  if (!brand) throw new NotFoundError('Brand');

  assertCan(ctx, 'ai_assistant:manage', { workspaceId: brand.workspaceId, brandId });
  return brand;
}

async function requireConversation(
  ctx: TenantContext,
  conversationId: string,
  permission: 'message:read' | 'message:reply',
) {
  requireUser(ctx);

  const conversation = await withTenant(ctx, (db) =>
    db.socialConversation.findFirst({
      where: { id: conversationId, socialAccount: { deletedAt: null } },
      select: {
        id: true,
        workspaceId: true,
        brandId: true,
        brand: { select: { name: true } },
        socialAccount: { select: { platform: true, accountType: true } },
      },
    }),
  );
  if (!conversation) throw new NotFoundError('Conversation');

  assertCan(ctx, permission, {
    workspaceId: conversation.workspaceId,
    brandId: conversation.brandId,
  });
  return conversation;
}

function requireUser(ctx: TenantContext): void {
  if (!isUserPrincipal(ctx.principal)) {
    throw new ForbiddenError('The assistant settings need a signed-in user', {
      userMessage: 'This action needs a signed-in user.',
      context: { actor: ctx.principal.actorName },
    });
  }
}

async function recentTurns(ctx: TenantContext, conversationId: string): Promise<AssistantTurn[]> {
  const recent = await withTenant(ctx, (db) =>
    db.socialMessage.findMany({
      where: { conversationId, deletedAt: null },
      select: { direction: true, text: true },
      orderBy: { sentAt: 'desc' },
      take: 10,
    }),
  );

  return recent
    .reverse()
    .filter((message) => message.text)
    .map((message) => ({
      from: message.direction === 'INBOUND' ? 'CUSTOMER' : 'BRAND',
      text: message.text as string,
    }));
}

/** One decision, metered: the same `decideReply` the worker uses. */
async function decide(
  ctx: TenantContext,
  input: {
    brandId: string;
    brandName: string;
    turns: AssistantTurn[];
    maxLength: number;
    operation: string;
  },
): Promise<{ decision: Decision; entries: { id: string; title: string }[] }> {
  const [voice, settings, entries] = await withTenant(ctx, (db: TenantDb) =>
    Promise.all([
      db.brandVoice.findFirst({
        where: { brandId: input.brandId },
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
      }),
      db.brandAssistant.findFirst({
        where: { brandId: input.brandId },
        select: { escalationTerms: true },
      }),
      db.brandKnowledgeEntry.findMany({
        // Internal notes never reach the model.
        where: { brandId: input.brandId, usableByAssistant: true },
        select: { id: true, title: true, question: true, content: true },
        orderBy: { updatedAt: 'desc' },
      }),
    ]),
  );

  const provider = aiProvider();
  const decision = await decideReply(provider, {
    brand: toBrandContext(input.brandName, voice),
    brandName: input.brandName,
    entries: entries.map((entry) => ({
      id: entry.id,
      title: entry.title,
      question: entry.question ?? undefined,
      content: entry.content,
    })),
    turns: input.turns,
    correlationId: ctx.correlationId,
    extraEscalationTerms: settings?.escalationTerms ?? [],
    maxLength: input.maxLength,
  });

  if (decision.usage || decision.failed) {
    await recordAIUsage(
      { ctx, brandId: input.brandId, operation: input.operation, correlationId: ctx.correlationId },
      provider,
      {
        inputTokens: decision.usage?.inputTokens ?? 0,
        outputTokens: decision.usage?.outputTokens ?? 0,
        latencyMs: decision.usage?.latencyMs ?? 0,
        succeeded: !decision.failed,
      },
    );
  }

  if (decision.failed) {
    logger.warn('the assistant model call failed', {
      organizationId: ctx.organizationId,
      operation: input.operation,
    });
  }

  return { decision, entries: entries.map((entry) => ({ id: entry.id, title: entry.title })) };
}

/** A decision as the page shows it: the cited entries by title, never by content. */
function present(
  decision: Decision,
  entries: readonly { id: string; title: string }[],
  options: { disclose: boolean },
) {
  const verdict = decision.verdict;
  if (verdict.action === 'ESCALATE') {
    return {
      action: 'ESCALATE' as const,
      category: verdict.category,
      reason: verdict.reason,
      text: null,
      cited: [],
    };
  }

  return {
    action: 'REPLY' as const,
    category: null,
    reason: null,
    // The test shows exactly what a customer would receive; a suggestion is
    // sent by a person, as themselves, and carries no disclosure.
    text: options.disclose ? withDisclosure(verdict.reply) : verdict.reply,
    cited: entries.filter((entry) => verdict.citedEntryIds.includes(entry.id)),
  };
}
