import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isAppError } from '@orbit/core';
import {
  SLACK_EVENT_LABELS,
  SLACK_EVENT_TYPES,
  escapeSlack,
  openSlackWebhook,
  parseSlackWebhookUrl,
  readSlackSettings,
  renderSlackMessage,
  sealSlackWebhook,
  sendSlackMessage,
  slackWants,
  withSlackSettings,
  type SecretCipher,
} from './slack.js';
import { NOTIFICATION_AUDIENCE } from './types.js';

/**
 * Slack delivery (D-129).
 *
 * The properties worth pinning are the ones that fail quietly: a URL the server
 * should never call, a post title that pings a whole channel, a webhook sealed
 * for one organization that opens for another, a revoked webhook retried for
 * ever.
 */

const HOOK = 'https://hooks.slack.com/services/T0001/B0002/abcDEF123';
const ORG = '018f0000-0000-7000-8000-000000000001';
const OTHER_ORG = '018f0000-0000-7000-8000-000000000002';

describe('which events', () => {
  it('sends only agency-audience events, each with a label', () => {
    for (const type of SLACK_EVENT_TYPES) {
      expect(NOTIFICATION_AUDIENCE[type], type).toBe('AGENCY');
      expect(SLACK_EVENT_LABELS[type].label.length, type).toBeGreaterThan(0);
    }
  });
});

describe('the webhook URL', () => {
  it('accepts a Slack incoming webhook, in canonical form', () => {
    expect(parseSlackWebhookUrl(HOOK)).toBe(HOOK);
    expect(parseSlackWebhookUrl(`  ${HOOK}  `)).toBe(HOOK);
  });

  it.each([
    ['plain http', 'http://hooks.slack.com/services/T0001/B0002/abc'],
    ['another host', 'https://hooks.slack.com.evil.test/services/T0001/B0002/abc'],
    ['a look-alike host', 'https://evilhooks.slack.com/services/T0001/B0002/abc'],
    ['credentials before the host', 'https://hooks.slack.com@evil.test/services/T0001/B0002/abc'],
    ['credentials in the URL', 'https://user:pw@hooks.slack.com/services/T0001/B0002/abc'],
    ['a port', 'https://hooks.slack.com:8443/services/T0001/B0002/abc'],
    ['a query', `${HOOK}?redirect=https://evil.test`],
    ['a fragment', `${HOOK}#x`],
    ['a workflow trigger', 'https://hooks.slack.com/triggers/T0001/123/abc'],
    ['a path escape', 'https://hooks.slack.com/services/T0001/../../evil'],
    ['an internal address', 'https://169.254.169.254/latest/meta-data'],
    ['not a URL', 'hooks.slack.com/services/T0001/B0002/abc'],
    ['empty', ''],
  ])('refuses %s', (_label, input) => {
    expect(parseSlackWebhookUrl(input)).toBeNull();
  });
});

describe('stored settings', () => {
  it('reads nothing from settings that have no Slack record, or a broken one', () => {
    expect(readSlackSettings({})).toBeNull();
    expect(readSlackSettings(null)).toBeNull();
    expect(readSlackSettings('slack')).toBeNull();
    expect(readSlackSettings({ slack: { webhook: '' } })).toBeNull();
    expect(readSlackSettings({ slack: [] })).toBeNull();
  });

  it('keeps known events and drops anything else', () => {
    const slack = readSlackSettings({
      slack: { webhook: 'sealed', events: ['publishing.failed', 'post.approved', 'nonsense', 4] },
    });

    expect(slack?.events).toEqual(['publishing.failed']);
  });

  it('decides per event whether the organization wants it', () => {
    const settings = { slack: { webhook: 'sealed', events: ['publishing.failed'] } };

    expect(slackWants(settings, 'publishing.failed')).toBe(true);
    expect(slackWants(settings, 'publishing.published')).toBe(false);
    // Never a type that is not meant for a channel, whatever is stored.
    expect(
      slackWants({ slack: { webhook: 'x', events: ['post.approved'] } }, 'post.approved'),
    ).toBe(false);
    expect(slackWants({}, 'publishing.failed')).toBe(false);
  });

  it('sends nothing once Slack has refused the webhook for good', () => {
    const settings = {
      slack: {
        webhook: 'sealed',
        events: ['publishing.failed'],
        failure: { reason: 'no_service', at: '2026-11-26T02:00:00.000Z' },
      },
    };

    expect(readSlackSettings(settings)?.failure).toEqual({
      reason: 'no_service',
      at: '2026-11-26T02:00:00.000Z',
    });
    expect(slackWants(settings, 'publishing.failed')).toBe(false);
  });

  it('replaces or removes only its own key', () => {
    const before = { theme: 'dark', slack: { webhook: 'old' } };
    const slack = readSlackSettings({ slack: { webhook: 'new' } })!;

    expect(withSlackSettings(before, slack)).toMatchObject({
      theme: 'dark',
      slack: { webhook: 'new' },
    });
    expect(withSlackSettings(before, null)).toEqual({ theme: 'dark' });
  });
});

describe('sealing', () => {
  // A real AES-GCM cipher with the same AAD handling as `CredentialCipher`, so
  // the binding is tested rather than mocked.
  const key = randomBytes(32);
  const cipher: SecretCipher = {
    seal(plaintext, aad) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      c.setAAD(Buffer.from(`${aad.organizationId}:${aad.socialAccountId}`));
      const ciphertext = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
      return { ciphertext, iv, authTag: c.getAuthTag(), keyVersion: 1 };
    },
    open(sealed, aad) {
      const d = createDecipheriv('aes-256-gcm', key, sealed.iv);
      d.setAAD(Buffer.from(`${aad.organizationId}:${aad.socialAccountId}`));
      d.setAuthTag(sealed.authTag);
      return Buffer.concat([d.update(sealed.ciphertext), d.final()]).toString('utf8');
    },
  };

  it('round-trips, and the stored form does not contain the URL', () => {
    const sealed = sealSlackWebhook(cipher, ORG, HOOK);

    expect(sealed).not.toContain('hooks.slack.com');
    expect(sealed).not.toContain('abcDEF123');
    expect(openSlackWebhook(cipher, ORG, sealed)).toBe(HOOK);
  });

  it('does not open for another organization', () => {
    const sealed = sealSlackWebhook(cipher, ORG, HOOK);

    expect(() => openSlackWebhook(cipher, OTHER_ORG, sealed)).toThrow();
  });

  it('refuses a malformed value', () => {
    expect(() => openSlackWebhook(cipher, ORG, 'not-sealed')).toThrow();
  });
});

describe('rendering', () => {
  const base = {
    url: 'https://www.socialsquare.site/orgs/ahn/posts/1',
    organizationName: 'AHN Media',
    workspaceName: 'Acme',
    brandName: 'Acme Bakery',
  };

  it('escapes what people wrote, so a title cannot ping the channel', () => {
    const message = renderSlackMessage({
      ...base,
      event: {
        type: 'post.canceled',
        postTitle: '<!channel> sale & <https://evil.test|click>',
        by: 'Linh',
      },
    });
    const all = JSON.stringify(message);

    expect(all).not.toContain('<!channel>');
    expect(all).not.toContain('<https://evil.test');
    expect(message.text).toContain('&lt;!channel&gt; sale &amp;');
  });

  it('links every account a post went live on, and names one with no link', () => {
    const message = renderSlackMessage({
      ...base,
      event: {
        type: 'publishing.published',
        postTitle: 'Spring launch',
        live: [
          { accountName: 'Acme Bakery', permalink: 'https://www.facebook.com/1_2?a=1&b=2' },
          { accountName: 'acme|bakery', permalink: null },
        ],
        partial: false,
      },
    });
    const section = (message.blocks?.[0] as { text: { text: string } }).text.text;

    expect(message.text).toBe('Spring launch is live');
    expect(section).toContain('<https://www.facebook.com/1_2?a=1&amp;b=2|Acme Bakery>');
    expect(section).toContain('• acme|bakery');
    expect(section).not.toContain('did not go out');
  });

  it('gives the reason a publish failed', () => {
    const message = renderSlackMessage({
      ...base,
      event: {
        type: 'publishing.failed',
        postTitle: 'Spring launch',
        accountName: 'Acme Bakery',
        summary: 'The platform rejected the content.',
        detail: 'The caption is longer than 2,200 characters.',
      },
    });

    expect(JSON.stringify(message)).toContain('The caption is longer than 2,200 characters.');
  });

  it('says where it happened and links back into the product', () => {
    const message = renderSlackMessage({
      ...base,
      event: { type: 'post.unscheduled', postTitle: 'Spring launch' },
    });
    const context = JSON.stringify(message.blocks?.[1]);

    expect(context).toContain('Acme · Acme Bakery · AHN Media');
    expect(context).toContain(`<${base.url}|Open in Social Square>`);
  });

  it('does not make a link of anything but http(s)', () => {
    const message = renderSlackMessage({
      ...base,
      event: {
        type: 'publishing.published',
        postTitle: 'X',
        live: [{ accountName: 'Acme', permalink: 'javascript:alert(1)' }],
        partial: false,
      },
    });

    expect(JSON.stringify(message)).not.toContain('javascript:');
  });

  it('escapes the three characters Slack reserves, and nothing else', () => {
    expect(escapeSlack('a < b > c & d *e*')).toBe('a &lt; b &gt; c &amp; d *e*');
  });
});

describe('sending', () => {
  const message = { text: 'hello' };

  function respond(status: number, body = '', headers: Record<string, string> = {}) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(body, { status, headers });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  async function failure(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    throw new Error('expected a failure');
  }

  it('posts JSON to the webhook and refuses to follow a redirect', async () => {
    const { calls, fetchImpl } = respond(200, 'ok');

    await sendSlackMessage(HOOK, message, { fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(HOOK);
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.redirect).toBe('error');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(message);
  });

  it('never calls a URL that is not a Slack webhook', async () => {
    const { calls, fetchImpl } = respond(200);

    const error = await failure(
      sendSlackMessage('https://169.254.169.254/latest', message, { fetchImpl }),
    );

    expect(calls).toHaveLength(0);
    expect(isAppError(error) && error.retryable).toBe(false);
  });

  it('retries a rate limit after the time Slack asks for', async () => {
    const { fetchImpl } = respond(429, 'rate_limited', { 'retry-after': '7' });

    const error = await failure(sendSlackMessage(HOOK, message, { fetchImpl }));

    expect(isAppError(error) && error.code).toBe('PROVIDER_RATE_LIMIT');
    expect(isAppError(error) && error.retryAfterSeconds).toBe(7);
  });

  it('retries an outage', async () => {
    const { fetchImpl } = respond(503);
    const error = await failure(sendSlackMessage(HOOK, message, { fetchImpl }));
    expect(isAppError(error) && error.retryable).toBe(true);

    const unreachable = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const network = await failure(sendSlackMessage(HOOK, message, { fetchImpl: unreachable }));
    expect(isAppError(network) && network.retryable).toBe(true);
  });

  it.each([400, 403, 404, 410])('does not retry what Slack refused (%i)', async (status) => {
    const { fetchImpl } = respond(status, 'no_service');

    const error = await failure(sendSlackMessage(HOOK, message, { fetchImpl }));

    expect(isAppError(error) && error.retryable).toBe(false);
  });

  it('never puts the webhook URL in an error', async () => {
    const { fetchImpl } = respond(404, 'no_service');

    const error = await failure(sendSlackMessage(HOOK, message, { fetchImpl }));

    expect(JSON.stringify(error)).not.toContain('abcDEF123');
    expect(String((error as Error).message)).not.toContain('abcDEF123');
  });
});
