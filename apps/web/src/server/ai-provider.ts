import { serverEnv } from '@orbit/config';
import { logger } from '@orbit/observability';
import {
  GeminiAgentModel,
  MockAIProvider,
  createAIProvider,
  type AIProvider,
  type AgentModel,
} from '@orbit/ai';

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

  // Shared with the worker (D-108), so the two cannot pick different models.
  // `APP_ENV` is the deployment's own word for where it is, the same test the
  // social registry makes, and it is not the mock's job to decide.
  cached = createAIProvider({
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL,
    production: env.APP_ENV === 'production',
  });

  if (cached instanceof MockAIProvider) {
    logger.warn('using the mock AI provider', { reason: 'GEMINI_API_KEY is not set' });
  } else {
    logger.info('AI provider registered', { provider: 'gemini', model: env.GEMINI_MODEL });
  }
  return cached;
}

/** Test seam, mirroring `resetRegistry` in the provider package. */
export function resetAIProvider(): void {
  cached = undefined;
  copilotOverride = undefined;
}

let copilotOverride: AgentModel | null | undefined;

/**
 * The tool-calling model behind the in-app Copilot (D-109 phase 5), or `null`.
 *
 * Only on Gemini's **paid** tier. On the free tier Google may use what is sent
 * to improve its products, and a Copilot sends a client's posts, analytics and
 * messages — so with `GEMINI_TIER=free` the Copilot is simply unavailable
 * rather than quietly sharing that. The MCP server is unaffected: there the
 * model is the person's own AI app.
 */
export function copilotModel(): AgentModel | null {
  if (copilotOverride !== undefined) return copilotOverride;
  const env = serverEnv();
  if (!env.GEMINI_API_KEY || env.GEMINI_TIER !== 'paid') return null;
  return new GeminiAgentModel({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL });
}

/** Test seam: a scripted model, or `null` for "unavailable". */
export function setCopilotModel(model: AgentModel | null): void {
  copilotOverride = model;
}
