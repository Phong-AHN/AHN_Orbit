import { PlanLimitExceededError, clock, isUserPrincipal, type TenantContext } from '@orbit/core';
import { withTenant, type TenantDb } from '@orbit/db';
import { logger } from '@orbit/observability';
import type { AIProvider, AIResult } from '@orbit/ai';
import { loadBrandContext } from '@/features/brand-voice/service';
import { assertAIRateLimit } from './rate-limit';

/**
 * Metering and grounding every AI call (T4.3, SRS §25, §38, risk **R11**).
 *
 * Every generation in the product goes through `runGeneration`, and that is the
 * point: the credit check, the usage row, and the brand grounding are not
 * things a new endpoint has to remember — they are the only way to make a call
 * at all.
 *
 * **One request is one credit.** Not one token. A per-request count is the one
 * a person can reason about ("fifty suggestions this month"), it does not
 * change meaning when the model does, and it cannot be gamed by a long prompt.
 * Token counts are still recorded on every row, because that is what a future
 * per-token plan or a cost investigation would need.
 *
 * **The check is before the call and the record is after it**, including when
 * the call fails. A failed generation still consumed a model call and still
 * cost money, so `AIUsage` carries `succeeded: false` rather than nothing —
 * a month of failures that left no trace would be a month of unexplained bill.
 */

export interface GenerationContext {
  ctx: TenantContext;
  brandId: string;
  operation: string;
  correlationId: string;
}

/**
 * The credit window.
 *
 * A calendar month in UTC, reset by the boundary rather than by a stored
 * counter — there is no field to drift, no job to run, and a query over an
 * indexed `(organizationId, createdAt)` answers it exactly.
 */
function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

interface PlanLimits {
  aiCreditsPerMonth?: number;
}

async function creditLimit(db: TenantDb): Promise<number | undefined> {
  const subscription = await db.subscription.findFirst({ select: { limits: true } });
  return (subscription?.limits as PlanLimits | undefined)?.aiCreditsPerMonth;
}

export interface CreditStatus {
  used: number;
  limit: number | undefined;
  remaining: number | undefined;
  periodStart: Date;
}

/** What has been spent this month, for the usage view and for the check below. */
export async function getCreditStatus(ctx: TenantContext): Promise<CreditStatus> {
  const periodStart = monthStart(clock.now());

  return withTenant(ctx, async (db) => {
    const [used, limit] = await Promise.all([
      db.aIUsage.count({ where: { createdAt: { gte: periodStart } } }),
      creditLimit(db),
    ]);

    return {
      used,
      limit,
      remaining: limit === undefined ? undefined : Math.max(0, limit - used),
      periodStart,
    };
  });
}

/**
 * Run one generation: check, ground, call, record.
 *
 * The provider is passed in rather than resolved here, so a test drives the
 * mock without stubbing this module and without a key existing anywhere
 * (**D-049**).
 */
export async function runGeneration<T>(
  input: GenerationContext,
  provider: AIProvider,
  call: (brand: Awaited<ReturnType<typeof loadBrandContext>>) => Promise<AIResult<T>>,
): Promise<AIResult<T>> {
  const { ctx, brandId, operation } = input;

  // Speed first, then volume. The monthly ceiling stops an organization
  // exceeding its plan; it does nothing about a loop burning that plan in
  // seconds. Refused here costs neither money nor a credit.
  await assertAIRateLimit(ctx);

  // Checked before spending anything. An organization at its limit gets a
  // sentence, not a provider error.
  const credits = await getCreditStatus(ctx);
  if (credits.limit !== undefined && credits.used >= credits.limit) {
    throw new PlanLimitExceededError(`AI credit limit reached (${credits.used}/${credits.limit})`, {
      userMessage: `This organization has used all ${credits.limit} AI suggestions for this month.`,
    });
  }

  // Loaded here, hard-scoped to one brand, so no endpoint can pass brand
  // context in from a request body (SRS §24). A brand from another tenant is
  // simply not found.
  const brand = await loadBrandContext(ctx, brandId);

  const started = Date.now();

  try {
    const result = await call(brand);

    await record(input, provider, {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: result.latencyMs,
      succeeded: true,
    });

    if (result.bannedTermHits.length > 0) {
      logger.info('a generation used a term the brand avoids', {
        organizationId: ctx.organizationId,
        brandId,
        operation,
        // The terms, not the text: the copy is the client's.
        bannedTermHits: result.bannedTermHits,
      });
    }

    return result;
  } catch (error) {
    // A failed call still cost a model request. Recording it is what makes the
    // bill explicable, and it is deliberately not counted against the credit
    // limit's *intent* — but it is counted, because it was spent.
    await record(input, provider, {
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - started,
      succeeded: false,
    });

    throw error;
  }
}

async function record(
  input: GenerationContext,
  provider: AIProvider,
  usage: { inputTokens: number; outputTokens: number; latencyMs: number; succeeded: boolean },
): Promise<void> {
  const { ctx, brandId, operation } = input;

  try {
    await withTenant(ctx, (db) =>
      db.aIUsage.create({
        data: {
          organizationId: ctx.organizationId,
          // Stamped from the application clock, not left to the database's
          // `now()`. The credit window is computed from `clock.now()`, so if the
          // rows were stamped by Postgres the two authorities could disagree —
          // harmlessly by a second most of the time, and by a whole month's
          // allowance for a request that lands either side of a boundary.
          createdAt: clock.now(),
          ...(isUserPrincipal(ctx.principal) ? { userId: ctx.principal.userId } : {}),
          brandId,
          operation,
          model: provider.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          latencyMs: usage.latencyMs,
          succeeded: usage.succeeded,
        },
      }),
    );
  } catch (error) {
    // Metering must not be the thing that fails a generation the user already
    // has in hand. Logged loudly, because a gap here is a gap in the bill.
    logger.error('could not record AI usage', {
      organizationId: ctx.organizationId,
      operation,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
