import { NotFoundError, ValidationError, clock, isAppError, type TenantContext } from '@orbit/core';
import { withTenant, type Prisma, type TenantDb } from '@orbit/db';
import {
  SLACK_EVENT_TYPES,
  openSlackWebhook,
  parseSlackWebhookUrl,
  readSlackSettings,
  renderSlackTest,
  sealSlackWebhook,
  sendSlackMessage,
  webhookHint,
  withSlackSettings,
  type SlackEventType,
  type SlackSettings,
} from '@orbit/notifications';
import { logger } from '@orbit/observability';
import { CredentialCipher } from '@orbit/providers';
import { audit, type AuditInput } from '@/server/audit';
import type { SaveSlackInput } from './contracts';

/**
 * An organization's Slack channel (D-129).
 *
 * Connected by whoever may change the organization (`org:update`, checked by
 * the route). The webhook is checked by **sending to it** before it is saved:
 * a URL that is well-formed but revoked, or pasted from the wrong workspace,
 * is found out now, by the person who can fix it, rather than at the next
 * failed publish.
 *
 * Nothing here ever returns the webhook URL, and the audit rows record that it
 * changed, never what it is.
 */

const cipher = new CredentialCipher();

/** What the settings page is allowed to know. */
export type SlackIntegrationView =
  | { connected: false }
  | {
      connected: true;
      channel: string | null;
      hint: string;
      events: SlackEventType[];
      connectedAt: string;
      connectedBy: string | null;
      failure: { reason: string; at: string } | null;
    };

export async function getSlackIntegration(ctx: TenantContext): Promise<SlackIntegrationView> {
  return withTenant(ctx, async (db) => view(readSlackSettings(await loadSettings(db))));
}

export async function saveSlackIntegration(
  ctx: TenantContext,
  input: SaveSlackInput,
  actor: { name: string | null },
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
): Promise<SlackIntegrationView> {
  const current = await withTenant(ctx, async (db) => readSlackSettings(await loadSettings(db)));

  let sealed = current?.webhook;
  let hint = current?.hint ?? '';
  let connectedAt = current?.connectedAt ?? clock.now().toISOString();
  let connectedBy = current?.connectedBy ?? null;
  let failure = current?.failure ?? null;
  const replacing = input.webhookUrl !== undefined;

  if (replacing) {
    const url = parseSlackWebhookUrl(input.webhookUrl ?? '');
    if (!url) {
      throw new ValidationError('Not a Slack incoming-webhook URL', {
        userMessage:
          'That is not a Slack incoming-webhook URL. It starts with https://hooks.slack.com/services/.',
        details: [{ field: 'webhookUrl', issue: 'not a Slack incoming-webhook URL' }],
      });
    }

    // Outside the transaction: an HTTP call has no business holding one open.
    await sendOrExplain(url, ctx);

    sealed = sealSlackWebhook(cipher, ctx.organizationId, url);
    hint = webhookHint(url);
    connectedAt = clock.now().toISOString();
    connectedBy = actor.name;
    // It has just been shown to work.
    failure = null;
  }

  if (!sealed) {
    throw new ValidationError('Slack is not connected', {
      userMessage: 'Paste the Slack webhook URL to connect.',
      details: [{ field: 'webhookUrl', issue: 'required to connect' }],
    });
  }

  const next: SlackSettings = {
    webhook: sealed,
    hint,
    channel: input.channel,
    events: SLACK_EVENT_TYPES.filter((type) => input.events.includes(type)),
    connectedAt,
    connectedBy,
    failure,
  };

  return withTenant(ctx, async (db) => {
    const settings = await loadSettings(db);
    await writeSettings(db, ctx.organizationId, withSlackSettings(settings, next));

    await audit(db, ctx, {
      action: current ? 'organization.slack_updated' : 'organization.slack_connected',
      resourceType: 'Organization',
      resourceId: ctx.organizationId,
      // What changed, never the webhook itself.
      after: { channel: next.channel, events: next.events, webhookReplaced: replacing },
      ...fingerprint,
    });

    return view(next);
  });
}

export async function disconnectSlack(
  ctx: TenantContext,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
): Promise<void> {
  await withTenant(ctx, async (db) => {
    const settings = await loadSettings(db);
    if (!readSlackSettings(settings)) return;

    await writeSettings(db, ctx.organizationId, withSlackSettings(settings, null));
    await audit(db, ctx, {
      action: 'organization.slack_disconnected',
      resourceType: 'Organization',
      resourceId: ctx.organizationId,
      ...fingerprint,
    });
  });
}

/**
 * Send the test message to the stored webhook.
 *
 * A success also clears a recorded refusal: the channel demonstrably takes
 * messages again, so the worker may resume.
 */
export async function testSlack(ctx: TenantContext): Promise<void> {
  const current = await withTenant(ctx, async (db) => readSlackSettings(await loadSettings(db)));
  if (!current) throw new NotFoundError('Slack connection');

  const url = openSlackWebhook(cipher, ctx.organizationId, current.webhook);
  await sendOrExplain(url, ctx);

  if (current.failure) {
    await withTenant(ctx, async (db) => {
      const settings = await loadSettings(db);
      const slack = readSlackSettings(settings);
      if (!slack || slack.webhook !== current.webhook) return;
      await writeSettings(
        db,
        ctx.organizationId,
        withSlackSettings(settings, { ...slack, failure: null }),
      );
    });
  }
}

// ── Internals ───────────────────────────────────────────────────────────────

async function loadSettings(db: TenantDb): Promise<unknown> {
  const organization = await db.organization.findFirst({ select: { settings: true } });
  if (!organization) throw new NotFoundError('Organization');
  return organization.settings;
}

async function writeSettings(
  db: TenantDb,
  organizationId: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await db.organization.update({
    where: { id: organizationId },
    data: { settings: settings as Prisma.InputJsonValue },
  });
}

function view(slack: SlackSettings | null): SlackIntegrationView {
  if (!slack) return { connected: false };
  return {
    connected: true,
    channel: slack.channel,
    hint: slack.hint,
    events: slack.events,
    connectedAt: slack.connectedAt,
    connectedBy: slack.connectedBy,
    failure: slack.failure,
  };
}

/** Send the hello message, turning Slack's refusal into something a person can act on. */
async function sendOrExplain(url: string, ctx: TenantContext): Promise<void> {
  const organization = await withTenant(ctx, (db) =>
    db.organization.findFirst({ select: { name: true } }),
  );

  try {
    await sendSlackMessage(url, renderSlackTest(organization?.name ?? 'your organization'));
  } catch (error) {
    logger.warn('slack test message was not accepted', {
      organizationId: ctx.organizationId,
      code: isAppError(error) ? error.code : 'UNKNOWN',
    });

    throw new ValidationError('Slack did not accept the test message', {
      userMessage:
        isAppError(error) && error.retryable
          ? 'Slack could not be reached just now. Try again in a minute.'
          : 'Slack refused this webhook. It may have been removed, or its channel archived. Create a new one and paste it here.',
      details: [{ field: 'webhookUrl', issue: 'Slack did not accept a test message' }],
    });
  }
}
