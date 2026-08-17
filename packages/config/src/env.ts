import { z } from 'zod';
import { loadRootEnv } from './load-env.js';

/**
 * Environment configuration (SRS §45).
 *
 * Validated once, lazily, on first access. A missing or malformed value throws
 * with every problem listed at once — the deploy fails, not the first request
 * that happens to need the value.
 *
 * Secrets are never logged. `describeEnv()` exists for the health endpoint and
 * reports presence only, never values.
 */

const base64Key = (bytes: number) =>
  z
    .string()
    .min(1)
    .refine(
      (v) => {
        try {
          return Buffer.from(v, 'base64').length === bytes;
        } catch {
          return false;
        }
      },
      { message: `must be ${bytes} bytes, base64-encoded` },
    );

const optionalUrl = z
  .string()
  .url()
  .optional()
  .or(z.literal('').transform(() => undefined));

/**
 * Optional, and an empty value means unset.
 *
 * `KEY=` in a `.env` file reads as "not configured" to everyone who writes one,
 * and several things here branch on presence — `selectIdentityProvider()` picks
 * Firebase the moment `FIREBASE_PROJECT_ID` has a value. Without this, blanking
 * a key to turn a feature off is a validation error instead, which pushes people
 * toward deleting lines and losing the documentation that came with them.
 */
const optionalString = z
  .string()
  .min(1)
  .optional()
  .or(z.literal('').transform(() => undefined));

export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // ── Data ──────────────────────────────────────────────────────────────────
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url().optional(),
  REDIS_URL: z.string().url(),

  // ── Worker (docs/ARCHITECTURE.md §5) ──────────────────────────────────────
  /**
   * Liveness and metrics port for the worker container. The worker has no
   * other HTTP surface; this is not routed publicly.
   */
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(3100),

  // ── Storage (SRS §17) ─────────────────────────────────────────────────────
  S3_REGION: z.string().min(1).default('eu-west-1'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_ENDPOINT: optionalUrl,
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(false),
  S3_PUBLIC_BASE_URL: optionalUrl,

  // ── Encryption (SRS §6) ───────────────────────────────────────────────────
  CREDENTIAL_ENCRYPTION_KEY: base64Key(32),
  CREDENTIAL_ENCRYPTION_KEY_VERSION: z.coerce.number().int().positive().default(1),
  STATE_SIGNING_SECRET: base64Key(32),

  // ── Firebase Admin (SRS §51) — server only, never sent to the browser ──────
  FIREBASE_PROJECT_ID: optionalString,
  FIREBASE_CLIENT_EMAIL: z
    .string()
    .email()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  /**
   * The service-account key, with its `\n` escapes restored.
   *
   * The refinement catches one specific, recurring paste error. The key is
   * copied out of the service-account JSON, and the trailing `",` comes with
   * it; because the value then does not end in a quote, `parseDotenv` treats it
   * as unquoted and never unescapes the newlines. What reaches OpenSSL is a
   * single line of text, and it answers `DECODER routines::unsupported` —
   * accurate, and useless for finding the cause.
   *
   * A dummy like `'key'` is left alone: only a value that is *trying* to be a
   * PEM is held to looking like one.
   */
  FIREBASE_PRIVATE_KEY: optionalString
    .transform((v) => v?.replace(/\\n/g, '\n'))
    .refine((v) => !v?.includes('BEGIN PRIVATE KEY') || /-----END PRIVATE KEY-----\s*$/.test(v), {
      message:
        'looks like a PEM key but does not end with the END line — check for a trailing comma or quote copied from the service-account JSON, and wrap the whole value in double quotes',
    }),
  FIREBASE_AUTH_EMULATOR_HOST: optionalString,

  /**
   * Firebase Web App config — public by design, and reaching the browser is the
   * point: it is what lets the client SDK obtain an ID token to exchange for a
   * session. The API key identifies the project, it does not authorize anything;
   * what protects the project is its Auth configuration.
   *
   * `projectId` is not repeated here — `FIREBASE_PROJECT_ID` is the same value
   * and equally public.
   */
  NEXT_PUBLIC_FIREBASE_API_KEY: optionalString,
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: optionalString,
  NEXT_PUBLIC_FIREBASE_APP_ID: optionalString,

  // ── Social providers (SRS §7) ─────────────────────────────────────────────
  FACEBOOK_APP_ID: optionalString,
  FACEBOOK_APP_SECRET: optionalString,
  /**
   * The Graph API version every provider call is made against.
   *
   * v25.0 (released 2026-02-18). Meta keeps a version alive for roughly two
   * years and v21.0 was within months of expiry; more to the point, Insights
   * **metric names change between versions**, so pinning this before the
   * analytics work begins is what stops the rollup being written twice
   * (docs/SOCIAL_PROVIDERS.md §3).
   *
   * Nothing in the publishing path changed across v22–v25: `/feed`, `/photos`,
   * `/me/accounts`, `/debug_token`, `/oauth/access_token`, `/media` and
   * `/media_publish` are untouched by those changelogs. The breaking changes in
   * that range are Marketing API, Live Video, and Certificate Transparency —
   * none of which this product calls.
   */
  FACEBOOK_GRAPH_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/)
    .default('v25.0'),
  FACEBOOK_WEBHOOK_VERIFY_TOKEN: optionalString,

  /**
   * Facebook Login for Business configuration id.
   *
   * Public, like the Firebase web keys — it names a consent configuration, it
   * grants nothing. Its presence is what switches the connect flow from a
   * full-page redirect to the JavaScript SDK's popup; absent, the redirect
   * flow is used, which is also what reconnection always uses.
   */
  NEXT_PUBLIC_FACEBOOK_CONFIG_ID: optionalString,

  /**
   * Business Login for Instagram — a *second* Meta app.
   *
   * Meta permits one API setup per app: an app configured for "Instagram Login"
   * cannot also serve "Facebook Login". So these are not the Facebook app's
   * credentials under another name, and the two flows cannot share one app no
   * matter how similar they look.
   *
   * Absent means the username login is simply not offered; the Page-linked flow
   * is unaffected.
   */
  INSTAGRAM_APP_ID: optionalString,
  INSTAGRAM_APP_SECRET: optionalString,

  /**
   * ── TikTok (SRS §7) ──────────────────────────────────────────────────────
   *
   * A TikTok app is entirely separate from any Meta app: its own portal, its
   * own review, its own key pair. Absent means TikTok is not offered at all.
   *
   * **Until TikTok audits the app, every post it makes is private**, whatever
   * privacy level the creator chooses — the same class of blocker as Meta's App
   * Review, and worth knowing before anyone schedules a campaign.
   */
  TIKTOK_CLIENT_KEY: optionalString,
  TIKTOK_CLIENT_SECRET: optionalString,

  // ── AI (SRS §51) ──────────────────────────────────────────────────────────
  GEMINI_API_KEY: optionalString,
  GEMINI_MODEL: z.string().default('gemini-2.0-flash'),

  // ── Billing (SRS §38) ─────────────────────────────────────────────────────
  STRIPE_SECRET_KEY: optionalString,
  STRIPE_WEBHOOK_SECRET: optionalString,

  // ── Observability (SRS §33) ───────────────────────────────────────────────
  SENTRY_DSN: optionalUrl,

  /**
   * ── Email (SRS §18, §22) ────────────────────────────────────────────────
   *
   * `RESEND_API_KEY` absent means email notifications are **not written at
   * all** — `channelsFor` returns in-app only, so the outbox stays empty rather
   * than filling with messages nothing will ever send. The in-app record is
   * unaffected either way, which is what stops a mail outage costing a
   * notification.
   *
   * `EMAIL_FROM` must be a sender the provider has verified, or every send is
   * refused.
   */
  EMAIL_FROM: z.string().email().default('orbit@example.com'),
  RESEND_API_KEY: optionalString,
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/**
 * Production requires the credentials that development can stub. Enforced
 * separately so local development stays frictionless while a production deploy
 * cannot start half-configured.
 */
const productionRequired = [
  'FIREBASE_PROJECT_ID',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_PRIVATE_KEY',
  // Without these the server verifies ID tokens nobody can obtain: the browser
  // has no way to reach Firebase, so sign-in is impossible and the only symptom
  // is a sign-in page that does nothing.
  'NEXT_PUBLIC_FIREBASE_API_KEY',
  'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
  'NEXT_PUBLIC_FIREBASE_APP_ID',
  'FACEBOOK_APP_ID',
  'FACEBOOK_APP_SECRET',
  'SENTRY_DSN',
] as const satisfies readonly (keyof ServerEnv)[];

/**
 * Why a `.env` sitting right there did not help.
 *
 * `next build` sets `NODE_ENV=production`, and `loadRootEnv` deliberately reads
 * nothing in production — deployed configuration comes from the platform, not a
 * file. The result is an error that looks like "you have no configuration" to
 * someone looking straight at their `.env`, which is the most misleading moment
 * this codebase produces. So the error explains itself rather than making the
 * reader remember.
 */
function productionHint(): string {
  const inProduction =
    process.env.APP_ENV === 'production' || process.env.NODE_ENV === 'production';

  if (!inProduction) return '';

  return [
    '',
    'NODE_ENV or APP_ENV is production, so `.env` was deliberately not read —',
    'deployed configuration comes from the platform.',
    '',
    '  • Building locally?  SKIP_ENV_VALIDATION=true pnpm build',
    '  • Deploying?         set these in your platform’s environment settings.',
    '',
    'See docs/DEPLOYMENT.md §2.',
  ].join('\n');
}

export class EnvValidationError extends Error {
  override readonly name = 'EnvValidationError';
  constructor(readonly issues: string[]) {
    super(
      `Invalid environment configuration:\n${issues.map((i) => `  • ${i}`).join('\n')}${productionHint()}`,
    );
  }
}

export function parseServerEnv(source?: NodeJS.ProcessEnv): ServerEnv {
  // Only when reading the ambient environment — a caller passing an explicit
  // source (tests) gets exactly what it passed.
  if (source === undefined) loadRootEnv();

  const parsed = serverEnvSchema.safeParse(source ?? process.env);

  if (!parsed.success) {
    throw new EnvValidationError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }

  const env = parsed.data;

  if (env.APP_ENV === 'production') {
    const missing = productionRequired.filter((key) => !env[key]);
    if (missing.length > 0) {
      throw new EnvValidationError(missing.map((k) => `${k}: required when APP_ENV=production`));
    }
    if (env.S3_ENDPOINT) {
      throw new EnvValidationError([
        'S3_ENDPOINT: must be unset in production — it exists only for local S3-compatible storage',
      ]);
    }
  }

  return env;
}

let cached: ServerEnv | undefined;

/**
 * Validated server environment. Throws on first access if misconfigured.
 *
 * `SKIP_ENV_VALIDATION` exists only so container image builds (which have no
 * secrets) can run `next build`. It must never be set at runtime.
 */
export function serverEnv(): ServerEnv {
  if (cached) return cached;
  if (process.env.SKIP_ENV_VALIDATION === 'true') {
    cached = serverEnvSchema.parse({
      DATABASE_URL: 'postgresql://build:build@localhost:5432/build',
      REDIS_URL: 'redis://localhost:6379',
      S3_BUCKET: 'build',
      S3_ACCESS_KEY_ID: 'build',
      S3_SECRET_ACCESS_KEY: 'build',
      CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
      STATE_SIGNING_SECRET: Buffer.alloc(32).toString('base64'),
    });
    return cached;
  }
  cached = parseServerEnv();
  return cached;
}

/** Test seam: drop the memoised value so a test can re-parse a different env. */
export function resetServerEnvCache(): void {
  cached = undefined;
}

/**
 * Presence-only view of configuration, safe to expose on the health endpoint.
 * Reports whether a secret is set — never what it is (SRS §33).
 */
export function describeEnv(env: ServerEnv = serverEnv()): Record<string, string | boolean> {
  return {
    appEnv: env.APP_ENV,
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    graphVersion: env.FACEBOOK_GRAPH_VERSION,
    aiModel: env.GEMINI_MODEL,
    hasFirebaseAdmin: Boolean(env.FIREBASE_PROJECT_ID && env.FIREBASE_PRIVATE_KEY),
    hasFacebookApp: Boolean(env.FACEBOOK_APP_ID && env.FACEBOOK_APP_SECRET),
    hasGemini: Boolean(env.GEMINI_API_KEY),
    hasStripe: Boolean(env.STRIPE_SECRET_KEY),
    hasSentry: Boolean(env.SENTRY_DSN),
    usesLocalStorageEmulator: Boolean(env.S3_ENDPOINT),
  };
}
