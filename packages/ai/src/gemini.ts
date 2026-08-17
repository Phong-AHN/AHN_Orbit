import {
  ProviderAuthenticationError,
  ProviderRateLimitError,
  ProviderUnavailableError,
  ProviderValidationError,
} from '@orbit/core';
import {
  adaptPrompt,
  captionPrompt,
  findBannedTerms,
  hashtagPrompt,
  rewritePrompt,
} from './prompt.js';
import type {
  AdaptInput,
  AIProvider,
  AIResult,
  CaptionInput,
  HashtagInput,
  RewriteInput,
} from './types.js';

/**
 * Gemini, over its REST API (SRS §23, T4.2).
 *
 * `fetch` rather than `@google/generative-ai`, matching how the social
 * providers talk to Meta: the request is a JSON body and a query parameter, the
 * SDK would add a dependency and a supply-chain surface for no capability we
 * need, and the shape below is small enough to read in one sitting.
 *
 * **The API key goes in the query string** because that is the only way this
 * API accepts one. That makes it a value which must never reach a log — the
 * URL is therefore built at the last moment and never included in an error, and
 * `redactUrl` in `@orbit/observability` exists for the same reason.
 */

export interface GeminiOptions {
  apiKey: string;
  model: string;
  /** Injectable for tests, so nothing here ever needs a network or a key. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** A generation nobody is watching is a generation nobody wants. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Low, and deliberately so.
 *
 * A caption is not creative writing to be surprised by; it is a first draft a
 * person will edit. Two runs of the same brief should look like the same brand.
 */
const TEMPERATURE = 0.7;

/** A cap in tokens, so a runaway generation cannot become a runaway bill. */
const MAX_OUTPUT_TOKENS = 1_024;

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  error?: { message?: string; status?: string };
}

export class GeminiProvider implements AIProvider {
  readonly name = 'gemini';

  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: GeminiOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  }

  get model(): string {
    return this.options.model;
  }

  async generateCaption(input: CaptionInput): Promise<AIResult<string>> {
    const result = await this.generate(captionPrompt(input), input.signal);
    return this.finish(clean(result.text), result, input.brand?.bannedTerms ?? []);
  }

  async rewriteContent(input: RewriteInput): Promise<AIResult<string>> {
    const result = await this.generate(rewritePrompt(input), input.signal);
    return this.finish(clean(result.text), result, input.brand?.bannedTerms ?? []);
  }

  async adaptForPlatform(input: AdaptInput): Promise<AIResult<string>> {
    const result = await this.generate(adaptPrompt(input), input.signal);
    return this.finish(clean(result.text), result, input.brand?.bannedTerms ?? []);
  }

  async generateHashtags(input: HashtagInput): Promise<AIResult<string[]>> {
    const result = await this.generate(hashtagPrompt(input), input.signal);
    const tags = parseHashtags(result.text, input.count);

    return {
      value: tags,
      model: this.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: result.latencyMs,
      bannedTermHits: findBannedTerms(tags.join(' '), input.brand?.bannedTerms ?? []),
    };
  }

  private finish(
    text: string,
    result: RawGeneration,
    bannedTerms: readonly string[],
  ): AIResult<string> {
    return {
      value: text,
      model: this.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: result.latencyMs,
      bannedTermHits: findBannedTerms(text, bannedTerms),
    };
  }

  /**
   * One call.
   *
   * Errors are mapped onto the product's own provider errors, so the queue's
   * retry policy and the API's error envelope treat a Gemini failure exactly as
   * they treat a Meta one — a rate limit is retryable, a bad key is not.
   */
  private async generate(prompt: string, signal?: AbortSignal): Promise<RawGeneration> {
    const started = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    let response: Response;

    try {
      response = await this.fetchImpl(
        // Built here and never stored: the key is in it.
        `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.options.apiKey)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: TEMPERATURE,
              maxOutputTokens: MAX_OUTPUT_TOKENS,
              candidateCount: 1,
            },
          }),
          signal: controller.signal,
        },
      );
    } catch (error) {
      // Includes the timeout. Retryable: the model was not reached, so nothing
      // happened that a second attempt would duplicate.
      throw new ProviderUnavailableError('Could not reach the model', {
        cause: error instanceof Error ? error : undefined,
        userMessage: 'The writing assistant is not responding. Try again in a moment.',
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    const body = (await response.json().catch(() => ({}))) as GeminiResponse;

    if (!response.ok) throw this.toError(response.status, body);

    const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
    const finishReason = body.candidates?.[0]?.finishReason;

    if (typeof text !== 'string' || text.trim().length === 0) {
      // A blocked or empty completion is a normal outcome, not a crash: safety
      // filters fire on ordinary marketing copy more often than anyone expects.
      throw new ProviderValidationError(
        `The model returned no usable text (finishReason: ${finishReason ?? 'unknown'})`,
        {
          userMessage:
            finishReason === 'SAFETY'
              ? 'The model declined to write that. Try rewording the brief.'
              : 'The model returned nothing usable. Try again.',
        },
      );
    }

    return {
      text,
      inputTokens: body.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0,
      latencyMs: Date.now() - started,
    };
  }

  /**
   * HTTP status onto a product error.
   *
   * The provider's message is deliberately not passed through to the user: it
   * is a vendor string that may name a model, a quota, or a project (SRS §33).
   * It goes in the log, keyed by correlation id.
   */
  private toError(status: number, body: GeminiResponse) {
    const detail = body.error?.message ?? `HTTP ${status}`;

    if (status === 401 || status === 403) {
      return new ProviderAuthenticationError(`Gemini rejected the credentials: ${detail}`, {
        userMessage: 'The writing assistant is not configured correctly. Tell an administrator.',
      });
    }

    if (status === 429) {
      return new ProviderRateLimitError(`Gemini rate limit: ${detail}`, {
        userMessage: 'The writing assistant is busy. Try again shortly.',
      });
    }

    if (status >= 500) {
      return new ProviderUnavailableError(`Gemini is unavailable: ${detail}`, {
        userMessage: 'The writing assistant is having trouble. Try again in a moment.',
      });
    }

    return new ProviderValidationError(`Gemini refused the request: ${detail}`, {
      userMessage: 'That could not be generated. Try rewording the brief.',
    });
  }
}

interface RawGeneration {
  text: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

/**
 * Strip what a model adds despite being asked not to.
 *
 * Code fences and wrapping quotes are the two it produces most, and both would
 * otherwise be pasted into a client's post.
 */
function clean(text: string): string {
  let value = text.trim();

  value = value.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
  value = value.trim();

  if (value.length > 1 && /^["'“](.*)["'”]$/s.test(value)) {
    value = value.slice(1, -1).trim();
  }

  return value;
}

/**
 * Hashtags out of whatever shape the model chose.
 *
 * Tolerant on purpose — spaces, newlines, commas, and a leading `#` that may or
 * may not be there. A malformed list is a normal response to handle, not an
 * error to raise.
 */
function parseHashtags(text: string, count: number): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];

  for (const token of text.split(/[\s,]+/)) {
    const tag = token.trim().replace(/^#+/, '');
    if (!/^[\p{L}\p{N}_]{2,60}$/u.test(tag)) continue;

    const key = tag.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    tags.push(`#${tag}`);
    if (tags.length >= count) break;
  }

  return tags;
}
