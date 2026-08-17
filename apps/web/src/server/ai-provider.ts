import { serverEnv } from '@orbit/config';
import { InternalError } from '@orbit/core';
import { logger } from '@orbit/observability';
import { GeminiProvider, MockAIProvider, type AIProvider } from '@orbit/ai';

/**
 * Which AI provider this process talks to (T4.2).
 *
 * The same shape as the social provider bootstrap next door, and for the same
 * reason: a key that is absent must produce an obvious answer rather than a
 * confusing one. Locally that answer is the mock, so the whole feature can be
 * built and tested without a Gemini project; in production it is a refusal,
 * because a client's suggestions quietly coming from a stub would be worse
 * than no suggestions at all.
 */

let cached: AIProvider | undefined;

export function aiProvider(): AIProvider {
  if (cached) return cached;

  const env = serverEnv();

  if (env.GEMINI_API_KEY) {
    cached = new GeminiProvider({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL });
    logger.info('AI provider registered', { provider: 'gemini', model: env.GEMINI_MODEL });
    return cached;
  }

  // The same test the social registry makes: `APP_ENV` is the deployment's own
  // word for where it is, and it is not the mock's job to decide.
  if (env.APP_ENV === 'production') {
    throw new InternalError('GEMINI_API_KEY is not set', {
      userMessage: 'The writing assistant is not configured. Tell an administrator.',
    });
  }

  cached = new MockAIProvider();
  logger.warn('using the mock AI provider', { reason: 'GEMINI_API_KEY is not set' });
  return cached;
}

/** Test seam, mirroring `resetRegistry` in the provider package. */
export function resetAIProvider(): void {
  cached = undefined;
}
