import { findBannedTerms } from './prompt.js';
import type {
  AdaptInput,
  AnswerMessageInput,
  AIProvider,
  AIResult,
  CaptionInput,
  HashtagInput,
  RewriteInput,
} from './types.js';

/**
 * A provider that answers without a network (T4.2).
 *
 * The registry hands this back when no API key is configured, which is what
 * lets the whole feature be developed and tested without a Gemini project —
 * and, more importantly, is what stops a test run from spending real money
 * against a real key (**D-047**, **D-049**).
 *
 * Its output is deterministic and derived from the input, so an assertion can
 * be exact rather than "contains some text". It is never registered when an
 * API key exists.
 */
export class MockAIProvider implements AIProvider {
  readonly name = 'mock';
  readonly model = 'mock-1';

  async generateCaption(input: CaptionInput): Promise<AIResult<string>> {
    const brand = input.brand?.brandName ?? 'the brand';
    const text = `${input.intent} — a suggested caption for ${brand}.`;

    return this.result(trim(text, input.maxLength), input);
  }

  async rewriteContent(input: RewriteInput): Promise<AIResult<string>> {
    const text =
      input.mode === 'shorten'
        ? input.text.split(/\s+/).slice(0, 12).join(' ')
        : input.mode === 'expand'
          ? `${input.text} And a little more, for the same idea.`
          : input.mode === 'tone'
            ? `(${input.tone ?? 'neutral'}) ${input.text}`
            : `Another way of saying it: ${input.text}`;

    return this.result(trim(text, input.maxLength), input);
  }

  /**
   * Deterministic, and it actually *applies* the constraints rather than
   * pretending to — a mock that ignored the length cap or kept a URL the target
   * cannot render would let a real bug through the tests that exist to catch it.
   */
  async adaptForPlatform(input: AdaptInput): Promise<AIResult<string>> {
    let text = `For ${input.targetPlatform}: ${input.text}`;

    if (input.supportsLinks === false) {
      text = text
        .replace(/https?:\/\/\S+/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
    }

    return this.result(trim(text, input.maxLength), input);
  }

  /**
   * Answer with the first document that shares a word with the customer's
   * latest message, quoted verbatim and cited — or escalate when none does.
   * Verbatim, so the answer always passes the grounding check, and a test
   * that wants it to fail has to say so by changing the documents.
   */
  async answerMessage(input: AnswerMessageInput): Promise<AIResult<string>> {
    const latest = [...input.turns].reverse().find((turn) => turn.from === 'CUSTOMER')?.text ?? '';
    const words = new Set(
      latest
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length > 2),
    );
    const match = input.entries.find((entry) =>
      `${entry.title} ${entry.question ?? ''}`
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .some((word) => words.has(word)),
    );

    const json = match
      ? JSON.stringify({ action: 'REPLY', reply: match.content, citedDocumentIds: [match.id] })
      : JSON.stringify({ action: 'ESCALATE', reason: 'no document covers this' });

    return {
      value: json,
      model: this.model,
      inputTokens: latest.length,
      outputTokens: json.length,
      latencyMs: 0,
      bannedTermHits: [],
    };
  }

  async generateHashtags(input: HashtagInput): Promise<AIResult<string[]>> {
    const words = input.text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 3);

    const tags = [...new Set(words)].slice(0, input.count).map((word) => `#${word}`);

    return {
      value: tags,
      model: this.model,
      inputTokens: input.text.length,
      outputTokens: tags.join(' ').length,
      latencyMs: 0,
      bannedTermHits: findBannedTerms(tags.join(' '), input.brand?.bannedTerms ?? []),
    };
  }

  private result(
    text: string,
    input: { brand: { bannedTerms: string[] } | null },
  ): AIResult<string> {
    return {
      value: text,
      model: this.model,
      inputTokens: text.length,
      outputTokens: text.length,
      latencyMs: 0,
      // Real, not stubbed: the banned-term check is product behaviour and the
      // mock must exercise the same code the live path does.
      bannedTermHits: findBannedTerms(text, input.brand?.bannedTerms ?? []),
    };
  }
}

function trim(text: string, maxLength: number | undefined): string {
  return maxLength && text.length > maxLength ? text.slice(0, maxLength) : text;
}
