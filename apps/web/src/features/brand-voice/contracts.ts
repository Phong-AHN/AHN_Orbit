import { z } from 'zod';

/**
 * Brand Brain — the context an agency writes once per brand (SRS §24).
 *
 * Every field is optional. A brand with three sentences filled in is more
 * useful to a generation than one nobody completed because the form demanded
 * twelve answers, and an empty Brand Brain must still be a valid one.
 *
 * The lengths are caps, not targets. They exist because this text is assembled
 * into a prompt: an unbounded field is an unbounded prompt, which is an
 * unbounded bill and eventually a refused request.
 */

const text = (max: number) => z.string().trim().max(max).optional();

/** Short lists of words. Long enough to be useful, short enough to stay a list. */
const terms = z.array(z.string().trim().min(1).max(80)).max(50).optional();

export const updateBrandVoiceSchema = z.object({
  companyDescription: text(2_000),
  productsServices: text(2_000),
  targetAudience: text(1_000),
  brandVoice: text(1_000),
  tone: text(200),

  preferredTerms: terms,
  /**
   * Words the brand will not use. Checked against every generation and
   * surfaced as a **warning**, never a block — the person writing knows the
   * context better than a word list does.
   */
  bannedTerms: terms,
  ctas: z.array(z.string().trim().min(1).max(200)).max(20).optional(),

  website: z.union([z.string().trim().url().max(500), z.literal('')]).optional(),

  /** A few posts that sound right. Examples teach tone better than adjectives. */
  exampleContent: z.array(z.string().trim().min(1).max(2_000)).max(10).optional(),
});

export type UpdateBrandVoiceInput = z.infer<typeof updateBrandVoiceSchema>;

/**
 * The assembled context, as the prompt builder consumes it.
 *
 * A separate type from the row on purpose: the row carries `organizationId`,
 * `updatedById` and timestamps, none of which have any business reaching a
 * model.
 */
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
