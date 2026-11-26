import {
  ProviderPermissionError,
  ProviderRateLimitError,
  ProviderUnavailableError,
  ProviderValidationError,
} from '@orbit/core';
import { notificationContent } from './content.js';
import type { NotificationEvent, NotificationType } from './types.js';

/**
 * Telling an organization's Slack channel what happened (D-129).
 *
 * ## Why per organization, and why a channel rather than people
 *
 * In-app and email notifications go to *people*, chosen by the policy engine.
 * Slack goes to the *team*: one channel an agency points at, where everybody
 * who works on its clients sees the publishing day go by. So it is configured
 * once per organization, by whoever may change the organization's settings,
 * and it carries only agency-audience events — nothing written for a client
 * ever reaches it.
 *
 * Per organization rather than one platform-wide channel because Social Square
 * serves more than one agency: a single channel would put every tenant's post
 * titles in front of whoever reads it.
 *
 * ## The webhook URL is a secret
 *
 * Anyone holding a Slack incoming-webhook URL can post into that channel as
 * the app. It is sealed with the credential cipher before it is stored, bound
 * to the organization, and never returned by any endpoint — the settings page
 * shows its last four characters, which is enough to recognise it.
 *
 * ## The server only ever calls Slack
 *
 * A URL a user types, that the server then POSTs to, is a server-side request
 * forgery waiting to happen. `parseSlackWebhookUrl` accepts nothing but
 * `https://hooks.slack.com/services/…`, and the sender refuses to follow
 * redirects, so the request cannot be steered anywhere else.
 */

// ── Which events ────────────────────────────────────────────────────────────

/**
 * What can be sent to Slack, in the order the settings page lists it.
 *
 * Only agency-audience types, and only the ones a team watching a channel
 * acts on. Review traffic stays out: it is addressed to individuals, and a
 * channel that announces every "needs your review" is a channel people mute.
 */
export const SLACK_EVENT_TYPES = [
  'publishing.published',
  'publishing.failed',
  'publishing.needs_review',
  'post.canceled',
  'post.unscheduled',
  'social_account.needs_reconnect',
] as const satisfies readonly NotificationType[];

export type SlackEventType = (typeof SLACK_EVENT_TYPES)[number];

export const SLACK_EVENT_LABELS: Record<SlackEventType, { label: string; hint: string }> = {
  'publishing.published': {
    label: 'Post published',
    hint: 'Once per post, with a link to it on every account it went out on.',
  },
  'publishing.failed': {
    label: 'Post failed',
    hint: 'Each account a post did not publish to, and why.',
  },
  'publishing.needs_review': {
    label: 'Outcome unknown',
    hint: 'We could not confirm whether a post went out, so someone needs to check.',
  },
  'post.canceled': {
    label: 'Scheduled post canceled',
    hint: 'A scheduled post was canceled and will not go out.',
  },
  'post.unscheduled': {
    label: 'Taken off the schedule',
    hint: 'A scheduled post went back to draft.',
  },
  'social_account.needs_reconnect': {
    label: 'Account needs reconnecting',
    hint: 'Posts for that account will not publish until someone reconnects it.',
  },
};

export function isSlackEvent(type: string): type is SlackEventType {
  return (SLACK_EVENT_TYPES as readonly string[]).includes(type);
}

// ── The webhook URL ─────────────────────────────────────────────────────────

const WEBHOOK_HOST = 'hooks.slack.com';
const WEBHOOK_PATH = /^\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+$/;

/**
 * The canonical form of a Slack incoming-webhook URL, or `null`.
 *
 * Strict on purpose — see "The server only ever calls Slack" above. No other
 * host, no port, no credentials in the URL, no query, and the path must be the
 * `/services/T…/B…/…` shape Slack issues. Workflow-builder webhooks
 * (`/triggers/…`) take a different payload and are refused rather than sent
 * messages they cannot read.
 */
export function parseSlackWebhookUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }

  if (url.protocol !== 'https:') return null;
  if (url.hostname !== WEBHOOK_HOST) return null;
  if (url.port !== '' || url.username !== '' || url.password !== '') return null;
  if (url.search !== '' || url.hash !== '') return null;
  if (!WEBHOOK_PATH.test(url.pathname)) return null;

  return `https://${WEBHOOK_HOST}${url.pathname}`;
}

/** The last four characters: enough to recognise a webhook, not to use one. */
export function webhookHint(url: string): string {
  return url.slice(-4);
}

// ── Stored settings ─────────────────────────────────────────────────────────

/**
 * What is kept under `Organization.settings.slack`.
 *
 * In the existing JSON column rather than a table: one optional record per
 * organization needs no migration, and every field is read whole.
 */
export interface SlackSettings {
  /** The sealed webhook URL — see `sealSlackWebhook`. Never the URL itself. */
  webhook: string;
  /** Last four characters of the URL, for the settings page. */
  hint: string;
  /** What the agency calls the channel, e.g. `#social-alerts`. Display only. */
  channel: string | null;
  events: SlackEventType[];
  connectedAt: string;
  connectedBy: string | null;
  /**
   * Set when Slack refused the webhook for good — removed, or its channel
   * archived. Nothing more is sent until somebody connects Slack again, and
   * the settings page says why, instead of every event failing in a queue
   * nobody reads.
   */
  failure: { reason: string; at: string } | null;
}

/**
 * Read the Slack record out of an organization's settings, defensively.
 *
 * The column is free-form JSON that outlives the code that wrote it, so
 * anything malformed reads as "not connected" rather than throwing in the
 * middle of a publish.
 */
export function readSlackSettings(settings: unknown): SlackSettings | null {
  if (!isRecord(settings)) return null;
  const slack = settings['slack'];
  if (!isRecord(slack)) return null;

  const webhook = slack['webhook'];
  if (typeof webhook !== 'string' || webhook.length === 0) return null;

  const events = Array.isArray(slack['events'])
    ? slack['events'].filter((e): e is SlackEventType => typeof e === 'string' && isSlackEvent(e))
    : [...SLACK_EVENT_TYPES];

  return {
    webhook,
    hint: typeof slack['hint'] === 'string' ? slack['hint'] : '',
    channel: typeof slack['channel'] === 'string' ? slack['channel'] : null,
    events,
    connectedAt: typeof slack['connectedAt'] === 'string' ? slack['connectedAt'] : '',
    connectedBy: typeof slack['connectedBy'] === 'string' ? slack['connectedBy'] : null,
    failure: readFailure(slack['failure']),
  };
}

function readFailure(value: unknown): SlackSettings['failure'] {
  if (!isRecord(value)) return null;
  const { reason, at } = value;
  return typeof reason === 'string' && typeof at === 'string' ? { reason, at } : null;
}

/** The settings object with the Slack record replaced, or removed for `null`. */
export function withSlackSettings(
  settings: unknown,
  slack: SlackSettings | null,
): Record<string, unknown> {
  const rest = isRecord(settings) ? { ...settings } : {};
  delete rest['slack'];
  return slack ? { ...rest, slack: { ...slack } } : rest;
}

/**
 * Whether this organization wants this event in its channel — and whether
 * the channel can still take it.
 */
export function slackWants(settings: unknown, type: string): boolean {
  if (!isSlackEvent(type)) return false;
  const slack = readSlackSettings(settings);
  return slack !== null && slack.failure === null && slack.events.includes(type);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── Sealing ─────────────────────────────────────────────────────────────────

/**
 * The credential cipher, as this module needs it.
 *
 * Structural, so `CredentialCipher` from `@orbit/providers` fits without this
 * package depending on the provider layer.
 */
export interface SecretCipher {
  seal(
    plaintext: string,
    aad: { organizationId: string; socialAccountId: string },
  ): { ciphertext: Uint8Array; iv: Uint8Array; authTag: Uint8Array; keyVersion: number };
  open(
    sealed: { ciphertext: Buffer; iv: Buffer; authTag: Buffer; keyVersion: number },
    aad: { organizationId: string; socialAccountId: string },
  ): string;
}

/**
 * Bound to the organization and to this purpose. A sealed webhook copied into
 * another organization's settings fails to open, and so does any other value
 * sealed under the same key.
 */
function aadFor(organizationId: string) {
  return { organizationId, socialAccountId: 'slack-webhook' };
}

export function sealSlackWebhook(
  cipher: SecretCipher,
  organizationId: string,
  url: string,
): string {
  const sealed = cipher.seal(url, aadFor(organizationId));
  return [
    String(sealed.keyVersion),
    Buffer.from(sealed.iv).toString('base64url'),
    Buffer.from(sealed.authTag).toString('base64url'),
    Buffer.from(sealed.ciphertext).toString('base64url'),
  ].join('.');
}

/** Throws when the value is malformed or does not belong to this organization. */
export function openSlackWebhook(
  cipher: SecretCipher,
  organizationId: string,
  sealed: string,
): string {
  const [keyVersion, iv, authTag, ciphertext] = sealed.split('.');
  if (!keyVersion || !iv || !authTag || !ciphertext) {
    throw new ProviderPermissionError('Stored Slack webhook is malformed', { platform: 'SLACK' });
  }

  return cipher.open(
    {
      keyVersion: Number(keyVersion),
      iv: Buffer.from(iv, 'base64url'),
      authTag: Buffer.from(authTag, 'base64url'),
      ciphertext: Buffer.from(ciphertext, 'base64url'),
    },
    aadFor(organizationId),
  );
}

// ── Sending ─────────────────────────────────────────────────────────────────

export interface SlackMessage {
  /** The notification and preview text. Also what a client without blocks shows. */
  text: string;
  blocks?: readonly Record<string, unknown>[];
}

export interface SlackSenderOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Post one message to an incoming webhook.
 *
 * Errors are classified for the queue: a network failure, a timeout, a 5xx and
 * a 429 are retried; anything else Slack refused — a revoked webhook, an
 * archived channel, a payload it rejects — would be refused again, so it is
 * not. No error message ever includes the URL.
 */
export async function sendSlackMessage(
  webhookUrl: string,
  message: SlackMessage,
  options: SlackSenderOptions = {},
): Promise<void> {
  const url = parseSlackWebhookUrl(webhookUrl);
  if (!url) {
    // Checked again here, not only when it was saved: this is the last line
    // before the server makes a request to it.
    throw new ProviderValidationError('Not a Slack incoming-webhook URL', { platform: 'SLACK' });
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(message),
      // Slack answers a webhook directly. A redirect would be somebody else.
      redirect: 'error',
      signal: controller.signal,
    });
  } catch (error) {
    throw new ProviderUnavailableError('Could not reach Slack', {
      platform: 'SLACK',
      cause: error instanceof Error ? error : undefined,
    });
  } finally {
    clearTimeout(timer);
  }

  if (response.ok) return;

  // Slack's error bodies are short codes like `no_service` or
  // `channel_is_archived` — useful in a log and free of anything sensitive.
  const detail = (await response.text().catch(() => '')).slice(0, 100);

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'));
    throw new ProviderRateLimitError('Slack rate limit', {
      platform: 'SLACK',
      httpStatus: 429,
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
    });
  }

  if (response.status >= 500) {
    throw new ProviderUnavailableError(`Slack answered ${response.status}`, {
      platform: 'SLACK',
      httpStatus: response.status,
      providerCode: detail,
    });
  }

  if (response.status === 400) {
    throw new ProviderValidationError(`Slack refused the message: ${detail}`, {
      platform: 'SLACK',
      httpStatus: 400,
      providerCode: detail,
      userMessage: 'Slack refused the message.',
    });
  }

  // 403, 404, 410: the webhook was revoked, the app removed, or the channel
  // archived. Nothing we send will land until someone connects Slack again.
  throw new ProviderPermissionError(`Slack refused the webhook: ${detail}`, {
    platform: 'SLACK',
    httpStatus: response.status,
    providerCode: detail,
    userMessage:
      'Slack refused the webhook. It may have been removed, or its channel archived — connect Slack again.',
  });
}

// ── Rendering ───────────────────────────────────────────────────────────────

export interface SlackNotice {
  event: NotificationEvent;
  /** A link into Social Square for the thing this is about. Absolute. */
  url: string;
  organizationName: string;
  workspaceName?: string | null | undefined;
  brandName?: string | null | undefined;
}

const ICONS: Record<SlackEventType, string> = {
  'publishing.published': ':white_check_mark:',
  'publishing.failed': ':x:',
  'publishing.needs_review': ':warning:',
  'post.canceled': ':no_entry_sign:',
  'post.unscheduled': ':leftwards_arrow_with_hook:',
  'social_account.needs_reconnect': ':electric_plug:',
};

/** Slack's section text limit is 3,000; a body is never close, but a title can be anything. */
const MAX_SECTION = 2_900;

/**
 * The message for one event.
 *
 * The words are `notificationContent`'s, so the channel, the bell and the
 * inbox say the same thing. Everything that came from a person — a post
 * title, an account name — is escaped, which is what stops a post called
 * `<!channel>` from pinging the whole channel.
 */
export function renderSlackMessage(notice: SlackNotice): SlackMessage {
  const { event } = notice;
  const content = notificationContent(event);
  const icon = isSlackEvent(event.type) ? ICONS[event.type] : ':bell:';

  const where = [notice.workspaceName, notice.brandName, notice.organizationName]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map(escapeSlack)
    .join(' · ');

  const body =
    event.type === 'publishing.published' ? publishedBody(event) : escapeSlack(content.body);

  const section = truncate(`${icon} *${escapeSlack(content.title)}*\n${body}`, MAX_SECTION);

  return {
    text: escapeSlack(content.title),
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: section } },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: [where, slackLink(notice.url, 'Open in Social Square')]
              .filter(Boolean)
              .join('  ·  '),
          },
        ],
      },
    ],
  };
}

/** The one message sent when somebody connects Slack, so they know it works. */
export function renderSlackTest(organizationName: string): SlackMessage {
  const text = `Social Square is connected. Publishing updates for ${escapeSlack(organizationName)} will appear in this channel.`;
  return {
    text,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `:wave: ${text}` } }],
  };
}

/** A published post's accounts, each a link to the live post where there is one. */
function publishedBody(
  event: Extract<NotificationEvent, { type: 'publishing.published' }>,
): string {
  const lines = event.live.map(
    (link) =>
      `• ${link.permalink ? slackLink(link.permalink, link.accountName) : escapeSlack(link.accountName)}`,
  );
  if (event.partial) {
    lines.push('_The other accounts did not go out — see the publishing log._');
  }
  return lines.join('\n');
}

/**
 * Slack's three control characters, escaped as Slack asks.
 *
 * `<` and `>` delimit mentions and links, so an unescaped title could ping
 * `@channel` or dress any URL up as anything.
 */
export function escapeSlack(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** `<url|label>`, for http(s) URLs only; anything else is shown as its label. */
function slackLink(url: string, label: string): string {
  if (!/^https?:\/\//i.test(url)) return escapeSlack(label);
  const safeUrl = url
    .replace(/&/g, '&amp;')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E')
    .replace(/\|/g, '%7C');
  return `<${safeUrl}|${escapeSlack(label).replace(/\|/g, '¦')}>`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
