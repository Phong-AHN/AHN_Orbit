import {
  ConflictError,
  NotFoundError,
  accessibleWorkspaceIds,
  clock,
  isUserPrincipal,
  type TenantContext,
} from '@orbit/core';
import { withTenant } from '@orbit/db';
import { audit, type AuditInput } from '@/server/audit';
import type { CreateIdeaInput, UpdateIdeaInput } from './contracts';

/**
 * Content ideas, and turning one into a post (SRS §25, Phase 4 P2).
 *
 * An idea is a note with a brand attached: the thing somebody writes down in a
 * planning meeting so it is not lost. It is deliberately not a draft — drafts
 * already exist, they carry variants and a state machine, and making ideas a
 * second kind of draft would give the product two answers to "where is our
 * content".
 *
 * **Converting creates a post and does not publish one.** The post arrives as a
 * `DRAFT` like any other and travels the same state machine from there; there
 * is no path from this file to a schedule or a publish (SRS §25).
 *
 * **An idea converts once.** The second attempt is refused rather than creating
 * a second post, which is what stops a double-clicked button producing two
 * drafts nobody notices until one publishes.
 */

const IDEA_SELECT = {
  id: true,
  workspaceId: true,
  brandId: true,
  topic: true,
  hook: true,
  platform: true,
  format: true,
  caption: true,
  cta: true,
  plannedFor: true,
  state: true,
  createdAt: true,
  updatedAt: true,
  generatedBy: { select: { id: true, name: true, email: true } },
  brand: { select: { id: true, name: true } },
  convertedPosts: { select: { id: true }, take: 1 },
} as const;

export interface IdeaFilter {
  workspaceId?: string;
  brandId?: string;
  state?: 'SUGGESTED' | 'ACCEPTED' | 'DISMISSED' | 'CONVERTED';
  search?: string;
  limit?: number;
}

export async function listIdeas(ctx: TenantContext, filter: IdeaFilter = {}) {
  const accessible = accessibleWorkspaceIds(ctx);
  const search = filter.search?.trim();

  return withTenant(ctx, (db) =>
    db.contentIdea.findMany({
      where: {
        ...(accessible === 'ALL' ? {} : { workspaceId: { in: [...accessible] } }),
        ...(filter.workspaceId ? { workspaceId: filter.workspaceId } : {}),
        ...(filter.brandId ? { brandId: filter.brandId } : {}),
        ...(filter.state ? { state: filter.state } : {}),
        ...(search
          ? {
              OR: [
                { topic: { contains: search, mode: 'insensitive' as const } },
                { hook: { contains: search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      select: IDEA_SELECT,
      // Planned ones first, soonest first; undated notes behind them.
      orderBy: [{ plannedFor: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
      take: Math.min(filter.limit ?? 100, 200),
    }),
  );
}

export async function getIdea(ctx: TenantContext, ideaId: string) {
  const idea = await withTenant(ctx, (db) =>
    db.contentIdea.findFirst({ where: { id: ideaId }, select: IDEA_SELECT }),
  );

  if (!idea) throw new NotFoundError('Content idea');
  return idea;
}

export async function createIdea(
  ctx: TenantContext,
  input: CreateIdeaInput,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    // Verified through the scoped client, so a brand from another organization
    // — or one not in the named workspace — is simply not found.
    const brand = await db.brand.findFirst({
      where: { id: input.brandId, workspaceId: input.workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!brand) throw new NotFoundError('Brand');

    const idea = await db.contentIdea.create({
      data: {
        organizationId: ctx.organizationId,
        workspaceId: input.workspaceId,
        brandId: input.brandId,
        topic: input.topic,
        hook: input.hook ?? null,
        platform: input.platform ?? null,
        format: input.format ?? null,
        caption: input.caption ?? null,
        cta: input.cta ?? null,
        plannedFor: input.plannedFor ? new Date(`${input.plannedFor}T00:00:00.000Z`) : null,
        // Authorship from the session, never the request.
        generatedById: isUserPrincipal(ctx.principal) ? ctx.principal.userId : null,
      },
      select: IDEA_SELECT,
    });

    await audit(db, ctx, {
      action: 'content_idea.created',
      resourceType: 'ContentIdea',
      resourceId: idea.id,
      workspaceId: input.workspaceId,
      brandId: input.brandId,
      after: { topic: idea.topic },
      ...fingerprint,
    });

    return idea;
  });
}

export async function updateIdea(
  ctx: TenantContext,
  ideaId: string,
  input: UpdateIdeaInput,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    const existing = await db.contentIdea.findFirst({
      where: { id: ideaId },
      select: { id: true, state: true, workspaceId: true, brandId: true },
    });
    if (!existing) throw new NotFoundError('Content idea');

    // A converted idea is a historical record of where a post came from.
    // Editing it would rewrite that provenance after the fact.
    if (existing.state === 'CONVERTED') {
      throw new ConflictError('Idea has already been converted', {
        userMessage: 'This idea became a post. Edit the post instead.',
      });
    }

    const idea = await db.contentIdea.update({
      where: { id: ideaId },
      data: {
        ...(input.topic !== undefined ? { topic: input.topic } : {}),
        ...(input.hook !== undefined ? { hook: input.hook } : {}),
        ...(input.platform !== undefined ? { platform: input.platform } : {}),
        ...(input.format !== undefined ? { format: input.format } : {}),
        ...(input.caption !== undefined ? { caption: input.caption } : {}),
        ...(input.cta !== undefined ? { cta: input.cta } : {}),
        ...(input.plannedFor !== undefined
          ? {
              plannedFor: input.plannedFor ? new Date(`${input.plannedFor}T00:00:00.000Z`) : null,
            }
          : {}),
        ...(input.state !== undefined ? { state: input.state } : {}),
      },
      select: IDEA_SELECT,
    });

    await audit(db, ctx, {
      action: 'content_idea.updated',
      resourceType: 'ContentIdea',
      resourceId: ideaId,
      workspaceId: existing.workspaceId,
      brandId: existing.brandId,
      after: { fields: Object.keys(input).sort() },
      ...fingerprint,
    });

    return idea;
  });
}

/**
 * Turn an idea into a draft post.
 *
 * One transaction, so the post and the idea's new state commit together — an
 * idea marked converted with no post, or a post whose idea still looks
 * unconverted, are both states somebody would have to unpick by hand.
 *
 * The post is a `DRAFT`. Nothing here schedules, approves or publishes: the
 * post enters the same state machine every other post does, and a person moves
 * it from there (SRS §25).
 */
export async function convertIdeaToPost(
  ctx: TenantContext,
  ideaId: string,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    const idea = await db.contentIdea.findFirst({
      where: { id: ideaId },
      select: {
        id: true,
        workspaceId: true,
        brandId: true,
        topic: true,
        hook: true,
        caption: true,
        cta: true,
        state: true,
      },
    });
    if (!idea) throw new NotFoundError('Content idea');

    // Converting twice would produce a second draft nobody asked for — and a
    // double-clicked button is the ordinary way that happens.
    if (idea.state === 'CONVERTED') {
      throw new ConflictError('Idea has already been converted', {
        userMessage: 'This idea is already a post.',
      });
    }

    const post = await db.post.create({
      data: {
        organizationId: ctx.organizationId,
        workspaceId: idea.workspaceId,
        brandId: idea.brandId,
        title: idea.topic,
        // Whatever the idea already had, in the order somebody would write it.
        // Empty is fine: the composer is where a post gets written.
        body: [idea.hook, idea.caption, idea.cta].filter(Boolean).join('\n\n'),
        status: 'DRAFT',
        source: 'AI_IDEA',
        sourceIdeaId: idea.id,
        createdById: isUserPrincipal(ctx.principal) ? ctx.principal.userId : null,
      },
      select: { id: true, title: true, body: true, status: true },
    });

    await db.contentIdea.update({
      where: { id: ideaId },
      data: { state: 'CONVERTED' },
    });

    await audit(db, ctx, {
      action: 'content_idea.converted',
      resourceType: 'ContentIdea',
      resourceId: ideaId,
      workspaceId: idea.workspaceId,
      brandId: idea.brandId,
      after: { postId: post.id },
      ...fingerprint,
    });

    return post;
  });
}

/**
 * What a brand has planned, and where the gaps are.
 *
 * The planning view SRS §25 asks for, built from rows that already exist rather
 * than a new model: ideas with a planned date, and posts already scheduled, on
 * one timeline. A gap is a week with neither.
 */
export async function planningWindow(
  ctx: TenantContext,
  input: { brandId: string; from: Date; to: Date },
) {
  return withTenant(ctx, async (db) => {
    const [ideas, posts] = await Promise.all([
      db.contentIdea.findMany({
        where: {
          brandId: input.brandId,
          state: { not: 'DISMISSED' },
          plannedFor: { gte: input.from, lte: input.to },
        },
        select: { id: true, topic: true, plannedFor: true, state: true, platform: true },
        orderBy: { plannedFor: 'asc' },
      }),

      db.post.findMany({
        where: {
          deletedAt: null,
          brandId: input.brandId,
          scheduledFor: { gte: input.from, lte: input.to },
        },
        select: { id: true, title: true, body: true, scheduledFor: true, status: true },
        orderBy: { scheduledFor: 'asc' },
      }),
    ]);

    return { ideas, posts, from: input.from, to: input.to, generatedAt: clock.now() };
  });
}
