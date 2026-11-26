import { serverEnv } from '@orbit/config';
import { InternalError } from '@orbit/core';
import { logger } from '@orbit/observability';
import { LogMailer, ResendMailer, formatSender, type Mailer } from '@orbit/notifications';

/**
 * Which mailer this worker uses (SRS §18).
 *
 * The same posture as the AI provider bootstrap (**D-068**): a key means the
 * real thing, no key means the log in development, and a refusal in production
 * — a client's approval request quietly going nowhere is worse than a loud
 * misconfiguration at boot.
 */

let cached: Mailer | undefined;

export function mailer(): Mailer {
  if (cached) return cached;

  const env = serverEnv();

  if (env.RESEND_API_KEY) {
    // `Social Square <socialsquare@ahnmedia.com>` by default (D-129). The
    // address must be on a domain verified in Resend, or every send is refused.
    const from = formatSender(env.EMAIL_FROM_NAME, env.EMAIL_FROM);
    cached = new ResendMailer({ apiKey: env.RESEND_API_KEY, from });
    logger.info('mailer registered', { provider: 'resend', from });
    return cached;
  }

  if (env.APP_ENV === 'production') {
    throw new InternalError('RESEND_API_KEY is not set but EMAIL notifications exist');
  }

  cached = new LogMailer();
  logger.warn('using the log mailer', { reason: 'RESEND_API_KEY is not set' });
  return cached;
}

/** Test seam. */
export function resetMailer(): void {
  cached = undefined;
}
