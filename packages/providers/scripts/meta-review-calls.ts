/**
 * One successful call per permission, so Meta's App Review screen stops saying
 * "requires 1 API call" (0/1) against each one.
 *
 *   node --experimental-strip-types packages/providers/scripts/meta-review-calls.ts
 *   node --experimental-strip-types packages/providers/scripts/meta-review-calls.ts --with-comment
 *
 * ## What counts, and why an app secret is not enough
 *
 * Meta counts a call against a permission only when it is made with a **user**
 * token that was granted that permission, for the app under review. An app
 * token (`app_id|secret`) proves the credentials and counts for nothing. So the
 * three tokens below have to come from a person logging in — the dashboards'
 * token generators are the shortest way, and need no redirect URI:
 *
 * | Variable in `.env` | Where to generate it |
 * |---|---|
 * | `META_REVIEW_FACEBOOK_USER_TOKEN` | Graph API Explorer → the Facebook app → User Token, every pages_*, instagram_*, read_insights, email permission ticked |
 * | `META_REVIEW_INSTAGRAM_TOKEN` | App Dashboard → Instagram → API setup with Instagram login → Generate access tokens |
 * | `META_REVIEW_THREADS_TOKEN` | App Dashboard → Threads use case → User Token Generator |
 *
 * Each person must hold a role on the app (admin, developer or tester) while
 * it is in development mode. A missing token skips that platform; it is not an
 * error.
 *
 * ## What it writes
 *
 * Read-only throughout, with two exceptions:
 *
 *  - `pages_manage_posts` creates an **unpublished** Page post and deletes it.
 *    Unpublished posts never appear on the Page.
 *  - `pages_manage_engagement` comments on the Page's latest post and deletes
 *    the comment — visible for a moment, so only with `--with-comment`.
 *
 * Publishing permissions for Instagram and Threads are exercised through their
 * publishing-limit endpoints, which need the publish permission and publish
 * nothing.
 *
 * Tokens are never printed. Counts on the App Review screen can take up to 24
 * hours to update.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Environment ─────────────────────────────────────────────────────────────

function loadEnv(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match && process.env[match[1]!] === undefined) {
      process.env[match[1]!] = match[2]!.replace(/^"(.*)"$/, '$1');
    }
  }
}

loadEnv(resolve(process.cwd(), '.env'));

const FB_VERSION = process.env.FACEBOOK_GRAPH_VERSION ?? 'v25.0';
const FB = `https://graph.facebook.com/${FB_VERSION}`;
const IG = 'https://graph.instagram.com';
const THREADS = 'https://graph.threads.net/v1.0';

const withComment = process.argv.includes('--with-comment');

// ── Calls ───────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

interface Outcome {
  permission: string;
  ok: boolean;
  detail: string;
}

const outcomes: Outcome[] = [];

/** Strip anything token-shaped from text that is about to be printed. */
function redact(text: string): string {
  return text.replace(/access_token=[^&\s"]+/g, 'access_token=***');
}

async function call(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  token: string,
  params: Record<string, string> = {},
): Promise<Json> {
  const target = new URL(url);
  const body = new URLSearchParams({ ...params, access_token: token });

  let response: Response;
  if (method === 'GET') {
    for (const [key, value] of body) target.searchParams.set(key, value);
    response = await fetch(target);
  } else {
    response = await fetch(target, { method, body });
  }

  const json = (await response.json().catch(() => ({}))) as Json;
  if (!response.ok || json.error) {
    const error = (json.error ?? {}) as { message?: string; code?: number };
    throw new Error(redact(`${error.code ?? response.status}: ${error.message ?? 'no message'}`));
  }
  return json;
}

async function exercise(permission: string, run: () => Promise<string>): Promise<void> {
  try {
    outcomes.push({ permission, ok: true, detail: await run() });
  } catch (error) {
    outcomes.push({
      permission,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function skip(permission: string, reason: string): void {
  outcomes.push({ permission, ok: false, detail: `skipped — ${reason}` });
}

const first = (json: Json): Json | undefined => (json.data as Json[] | undefined)?.[0];

/**
 * A media item that actually has comments, falling back to the latest.
 *
 * Reading the comments of a post that has none returns an empty list, and Meta
 * did not count that call against either comment permission: both stayed at
 * 0/1 while every other permission went to 1/1. So read a thread that exists.
 */
async function commentedMedia(host: string, igUser: string, token: string): Promise<string | null> {
  const media = await call('GET', `${host}/${igUser}/media`, token, {
    fields: 'id,comments_count',
    limit: '50',
  });
  const items = (media.data as Json[] | undefined) ?? [];
  const withComments = items.find((m) => Number(m.comments_count ?? 0) > 0);
  return ((withComments ?? items[0])?.id as string | undefined) ?? null;
}

/** Read a media item's comments, then one comment on its own. */
async function readComments(host: string, mediaId: string, token: string): Promise<string> {
  const comments = await call('GET', `${host}/${mediaId}/comments`, token, {
    fields: 'id,text,username,timestamp',
  });
  const list = (comments.data as Json[] | undefined) ?? [];
  if (list.length === 0) throw new Error('no comments on any media — add one, then rerun');
  await call('GET', `${host}/${String(list[0]!.id)}`, token, {
    fields: 'id,text,username,timestamp',
  });
  return `${list.length} comment(s) read`;
}

// ── Facebook Login (pages_*, instagram_* on the Page-linked surface) ────────

async function facebook(token: string): Promise<void> {
  await exercise('public_profile', async () => {
    const me = await call('GET', `${FB}/me`, token, { fields: 'id,name' });
    return `me = ${String(me.name)}`;
  });

  await exercise('email', async () => {
    const me = await call('GET', `${FB}/me`, token, { fields: 'email' });
    return me.email ? 'email returned' : 'call succeeded, no email on the profile';
  });

  let page: { id: string; name: string; token: string } | null = null;

  await exercise('pages_show_list', async () => {
    const accounts = await call('GET', `${FB}/me/accounts`, token, {
      fields: 'id,name,access_token',
      limit: '25',
    });
    const pages = (accounts.data as Json[] | undefined) ?? [];
    const wanted = process.env.META_REVIEW_PAGE_ID;
    const chosen = wanted ? pages.find((p) => p.id === wanted) : pages[0];
    if (chosen) {
      page = {
        id: String(chosen.id),
        name: String(chosen.name),
        token: String(chosen.access_token),
      };
    }
    return `${pages.length} page(s)${page ? `, using "${page.name}"` : ''}`;
  });

  if (!page) {
    for (const permission of [
      'pages_read_engagement',
      'pages_read_user_content',
      'read_insights',
      'pages_manage_posts',
      'pages_manage_engagement',
      'instagram_basic',
      'instagram_content_publish',
      'instagram_manage_comments',
    ]) {
      skip(permission, 'no Page reachable with this token');
    }
    return;
  }
  const p = page as { id: string; name: string; token: string };

  let latestPostId: string | null = null;

  await exercise('pages_read_engagement', async () => {
    const info = await call('GET', `${FB}/${p.id}`, p.token, {
      fields: 'name,followers_count,fan_count',
    });
    const feed = await call('GET', `${FB}/${p.id}/feed`, p.token, {
      fields: 'id,created_time',
      limit: '1',
    });
    latestPostId = (first(feed)?.id as string | undefined) ?? null;
    return `followers = ${String(info.followers_count ?? 'n/a')}`;
  });

  await exercise('pages_read_user_content', async () => {
    if (!latestPostId) throw new Error('the Page has no posts to read comments from');
    const comments = await call('GET', `${FB}/${latestPostId}/comments`, p.token, {
      fields: 'id,from,message',
      limit: '5',
    });
    return `${((comments.data as Json[] | undefined) ?? []).length} comment(s) on the latest post`;
  });

  await exercise('read_insights', async () => {
    const insights = await call('GET', `${FB}/${p.id}/insights`, p.token, {
      metric: 'page_post_engagements,page_follows',
      period: 'day',
    });
    return `${((insights.data as Json[] | undefined) ?? []).length} metric(s)`;
  });

  await exercise('pages_manage_posts', async () => {
    const created = await call('POST', `${FB}/${p.id}/feed`, p.token, {
      message: 'Orbit App Review check — unpublished, deleted immediately.',
      published: 'false',
    });
    await call('DELETE', `${FB}/${String(created.id)}`, p.token);
    return 'unpublished post created and deleted';
  });

  if (withComment) {
    await exercise('pages_manage_engagement', async () => {
      if (!latestPostId) throw new Error('the Page has no published post to comment on');
      const comment = await call('POST', `${FB}/${latestPostId}/comments`, p.token, {
        message: 'Orbit App Review check — removing this now.',
      });
      await call('DELETE', `${FB}/${String(comment.id)}`, p.token);
      return 'comment posted and deleted';
    });
  } else {
    skip('pages_manage_engagement', 'writes a visible comment; rerun with --with-comment');
  }

  // The Instagram account linked to this Page, on the Facebook Login surface.
  let igUserId: string | null = null;

  await exercise('instagram_basic', async () => {
    const linked = await call('GET', `${FB}/${p.id}`, p.token, {
      fields: 'instagram_business_account',
    });
    const account = linked.instagram_business_account as Json | undefined;
    if (!account?.id) throw new Error(`"${p.name}" has no linked Instagram professional account`);
    igUserId = String(account.id);
    const profile = await call('GET', `${FB}/${igUserId}`, p.token, {
      fields: 'username,media_count',
    });
    return `@${String(profile.username)}`;
  });

  if (!igUserId) {
    skip('instagram_content_publish', 'no linked Instagram account');
    skip('instagram_manage_comments', 'no linked Instagram account');
    return;
  }
  const ig = igUserId as string;

  await exercise('instagram_content_publish', async () => {
    await call('GET', `${FB}/${ig}/content_publishing_limit`, p.token, {
      fields: 'quota_usage,config',
    });
    return 'publishing limit read (nothing published)';
  });

  await exercise('instagram_manage_comments', async () => {
    const mediaId = await commentedMedia(FB, ig, p.token);
    if (!mediaId) throw new Error('the Instagram account has no media to read comments from');
    return readComments(FB, mediaId, p.token);
  });
}

// ── Business Login for Instagram (instagram_business_*) ─────────────────────

async function instagram(token: string): Promise<void> {
  let userId: string | null = null;
  let mediaId: string | null = null;

  await exercise('instagram_business_basic', async () => {
    const me = await call('GET', `${IG}/me`, token, { fields: 'user_id,username' });
    userId = String(me.user_id);
    mediaId = await commentedMedia(IG, 'me', token);
    return `@${String(me.username)}`;
  });

  if (!userId) {
    for (const permission of [
      'instagram_business_content_publish',
      'instagram_business_manage_comments',
      'instagram_business_manage_insights',
    ]) {
      skip(permission, 'the token did not resolve an account');
    }
    return;
  }

  await exercise('instagram_business_content_publish', async () => {
    await call('GET', `${IG}/me/content_publishing_limit`, token, {
      fields: 'quota_usage,config',
    });
    return 'publishing limit read (nothing published)';
  });

  await exercise('instagram_business_manage_comments', async () => {
    if (!mediaId) throw new Error('the account has no media to read comments from');
    return readComments(IG, mediaId, token);
  });

  await exercise('instagram_business_manage_insights', async () => {
    const insights = await call('GET', `${IG}/me/insights`, token, {
      metric: 'reach,views',
      period: 'day',
      metric_type: 'total_value',
    });
    return `${((insights.data as Json[] | undefined) ?? []).length} metric(s)`;
  });
}

// ── Threads ─────────────────────────────────────────────────────────────────

async function threads(token: string): Promise<void> {
  await exercise('threads_basic', async () => {
    const me = await call('GET', `${THREADS}/me`, token, { fields: 'id,username' });
    await call('GET', `${THREADS}/me/threads`, token, { fields: 'id', limit: '1' });
    return `@${String(me.username)}`;
  });

  await exercise('threads_content_publish', async () => {
    await call('GET', `${THREADS}/me/threads_publishing_limit`, token, {
      fields: 'quota_usage,config',
    });
    return 'publishing limit read (nothing published)';
  });
}

// ── Run ─────────────────────────────────────────────────────────────────────

const surfaces: Array<[string, string | undefined, (token: string) => Promise<void>]> = [
  ['Facebook Login', process.env.META_REVIEW_FACEBOOK_USER_TOKEN, facebook],
  ['Instagram Business Login', process.env.META_REVIEW_INSTAGRAM_TOKEN, instagram],
  ['Threads', process.env.META_REVIEW_THREADS_TOKEN, threads],
];

for (const [name, token, run] of surfaces) {
  if (!token) {
    console.log(`\n${name}: no token in .env — skipped`);
    continue;
  }
  const before = outcomes.length;
  await run(token.trim());
  console.log(`\n${name}`);
  for (const outcome of outcomes.slice(before)) {
    console.log(`  ${outcome.ok ? '✓' : '✗'} ${outcome.permission.padEnd(38)} ${outcome.detail}`);
  }
}

const passed = outcomes.filter((o) => o.ok).length;
console.log(`\n${passed} of ${outcomes.length} permission calls succeeded.`);
