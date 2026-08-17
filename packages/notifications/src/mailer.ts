import { ProviderRateLimitError, ProviderUnavailableError } from '@orbit/core';
import { logger } from '@orbit/observability';

/**
 * Sending mail (SRS §18).
 *
 * An interface plus one implementation, the same shape the social and AI
 * providers use — business logic depends on `Mailer`, never on a vendor, and
 * swapping Resend for SES or Postmark is one file.
 *
 * **`fetch` rather than an SDK**, matching the precedent set for Gemini
 * (**D-068**): the request is a JSON body and a bearer token, and an SDK would
 * add a dependency and a supply-chain surface for no capability needed here.
 *
 * **No key means the log, not silence.** A `LogMailer` renders what *would*
 * have been sent so the whole flow is exercisable in development — and the row
 * is still stamped, so a developer's mailbox is not required to test the outbox
 * draining. Production refuses at startup instead, because a client's approval
 * request quietly going nowhere is worse than a loud misconfiguration.
 */

export interface Email {
  to: string;
  subject: string;
  /** Plain text. Deliberately not HTML — see `renderEmail`. */
  text: string;
}

export interface Mailer {
  readonly name: string;
  send(email: Email): Promise<void>;
}

export interface ResendOptions {
  apiKey: string;
  /** A verified sender on the account, e.g. `Orbit <notifications@example.com>`. */
  from: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

const RESEND_URL = 'https://api.resend.com/emails';
const DEFAULT_TIMEOUT_MS = 15_000;

export class ResendMailer implements Mailer {
  readonly name = 'resend';

  private readonly fetchImpl: typeof fetch;
  private readonly url: string;

  constructor(private readonly options: ResendOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.url = options.baseUrl ?? RESEND_URL;
  }

  async send(email: Email): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    let response: Response;

    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          // The key is a header rather than a query parameter, so it is one
          // fewer place it can end up in a log or a redirect.
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: this.options.from,
          to: [email.to],
          subject: email.subject,
          text: email.text,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      // Includes the timeout. Retryable: nothing was sent, so a second attempt
      // cannot duplicate a message.
      throw new ProviderUnavailableError('Could not reach the mail provider', {
        cause: error instanceof Error ? error : undefined,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) return;

    const detail = await response.text().catch(() => `HTTP ${response.status}`);

    if (response.status === 429) {
      throw new ProviderRateLimitError(`Mail provider rate limit: ${truncate(detail)}`);
    }

    // 4xx other than 429 is our mistake — a bad address, an unverified sender —
    // and retrying sends the same broken request. It still throws, so the row
    // stays unstamped and a human can see it in the log, but the queue's own
    // policy decides whether that is worth another attempt.
    throw new ProviderUnavailableError(
      `Mail provider refused the message (${response.status}): ${truncate(detail)}`,
    );
  }
}

/**
 * Development only. Renders the message to the log instead of sending it.
 *
 * Registered only when no key is configured and the environment is not
 * production — the same posture as the mock AI provider (**D-068**).
 */
export class LogMailer implements Mailer {
  readonly name = 'log';

  async send(email: Email): Promise<void> {
    logger.info('email (not sent — no mail provider configured)', {
      to: email.to,
      subject: email.subject,
      // The body is not logged. It carries a client's post title and an
      // agency's internal wording, and a log is a wider audience than an inbox.
      bodyLength: email.text.length,
    });
  }
}

/** Provider text can be long and can echo the payload; the log wants neither. */
function truncate(value: string): string {
  return value.length > 200 ? `${value.slice(0, 200)}…` : value;
}
