/**
 * The AI provider contract (SRS §23, docs/ARCHITECTURE.md §7).
 *
 * Business logic depends on this interface and never on a vendor, and the model
 * id is configuration rather than a literal in a service. The shape is
 * deliberately narrow: three operations for Phase 4 P1, with the rest of §7's
 * surface left unimplemented rather than stubbed, so nothing can call a method
 * that quietly returns nothing.
 */

/** Brand Brain, as a generation consumes it. Data — never instructions. */
export interface BrandContext {
  brandName: string;
  companyDescription?: string | undefined;
  productsServices?: string | undefined;
  targetAudience?: string | undefined;
  brandVoice?: string | undefined;
  tone?: string | undefined;
  preferredTerms: string[];
  bannedTerms: string[];
  ctas: string[];
  website?: string | undefined;
  exampleContent: string[];
}

export interface GenerationBase {
  /** Grounding for this call, or null when the brand has no Brand Brain yet. */
  brand: BrandContext | null;
  /** Which platform the text is for, so length and register can suit it. */
  platform?: string | undefined;
  correlationId: string;
  signal?: AbortSignal | undefined;
}

export interface CaptionInput extends GenerationBase {
  /** What the post is about, in the user's words. */
  intent: string;
  /** A hard cap the platform imposes; the model is told, and output is checked. */
  maxLength?: number | undefined;
}

export type RewriteMode = 'shorten' | 'expand' | 'rephrase' | 'tone';

export interface RewriteInput extends GenerationBase {
  text: string;
  mode: RewriteMode;
  /** Only meaningful for `tone`. */
  tone?: string | undefined;
  maxLength?: number | undefined;
}

export interface HashtagInput extends GenerationBase {
  text: string;
  count: number;
}

/**
 * Adapting existing content for a different platform (SRS §25, Phase 4 P2).
 *
 * The distinction from `rewrite` is the point: rewriting changes the words,
 * adapting changes what the words are *for*. A Facebook post that opens with
 * three paragraphs of context and closes with a link becomes, on Instagram, a
 * shorter piece with the link removed — because Instagram captions do not carry
 * clickable links, and a caption that says "click the link" when there is none
 * makes a client look careless.
 *
 * `sourcePlatform` is optional because content is often adapted from something
 * that was never published anywhere.
 */
export interface AdaptInput extends GenerationBase {
  text: string;
  /** Where it is going. Drives length, register, and link handling. */
  targetPlatform: string;
  /** Where it came from, when it came from somewhere. */
  sourcePlatform?: string | undefined;
  /** The target's own cap, from its capability descriptor — never guessed. */
  maxLength?: number | undefined;
  /** Whether the target renders links at all. Instagram captions do not. */
  supportsLinks?: boolean | undefined;
}

/**
 * Everything a generation returns.
 *
 * A **suggestion**, never an action. The caller decides what to do with the
 * text; nothing in this package writes to a post, and nothing in it can reach
 * publishing (SRS §25).
 */
export interface AIResult<T> {
  value: T;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /**
   * Brand banned terms found in the output.
   *
   * A **warning**, not a rejection. The person writing knows the context better
   * than a word list does, so the result is returned either way and the surface
   * says what it found.
   */
  bannedTermHits: string[];
}

export interface AIProvider {
  readonly name: string;
  readonly model: string;

  generateCaption(input: CaptionInput): Promise<AIResult<string>>;
  rewriteContent(input: RewriteInput): Promise<AIResult<string>>;
  generateHashtags(input: HashtagInput): Promise<AIResult<string[]>>;

  /**
   * Rework content for a different platform.
   *
   * Returns a **suggestion** like everything else here: it never writes to a
   * post, and the caller decides whether to keep it (SRS §25).
   */
  adaptForPlatform(input: AdaptInput): Promise<AIResult<string>>;
}
