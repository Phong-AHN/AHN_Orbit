import { describe, expect, it } from 'vitest';
import { GeminiProvider } from './gemini.js';
import { explanationIsGrounded, numbersIn, parseIdeas, type ExplainInput } from './planning.js';

describe('parseIdeas', () => {
  it('keeps what fits the idea contract and drops the rest', () => {
    const raw = JSON.stringify({
      ideas: [
        { topic: 'Networking night recap', platform: 'facebook', reason: 'Recaps did well' },
        { topic: 'Networking night recap' },
        { topic: 'ab' },
        { topic: 'Founder Q&A', platform: 'MYSPACE' },
        { nope: true },
      ],
    });
    const ideas = parseIdeas(raw, { max: 10, platforms: ['FACEBOOK', 'INSTAGRAM'] });
    expect(ideas.map((i) => i.topic)).toEqual(['Networking night recap', 'Founder Q&A']);
    expect(ideas[0]!.platform).toBe('FACEBOOK');
    expect(ideas[1]!.platform).toBeNull();
  });

  it('returns nothing for something that is not the schema', () => {
    expect(parseIdeas('not json', { max: 5, platforms: [] })).toEqual([]);
    expect(parseIdeas('{"ideas": "x"}', { max: 5, platforms: [] })).toEqual([]);
  });

  it('caps the count', () => {
    const raw = JSON.stringify({
      ideas: Array.from({ length: 30 }, (_, i) => ({ topic: `Idea number ${i}` })),
    });
    expect(parseIdeas(raw, { max: 5, platforms: [] })).toHaveLength(5);
  });
});

describe('explanationIsGrounded', () => {
  const input: ExplainInput = {
    brand: null,
    correlationId: 'test',
    period: { from: '2026-10-01', to: '2026-10-31' },
    previousPeriod: { from: '2026-09-01', to: '2026-09-30' },
    facts: [
      { label: 'post_media_view', current: 48_600, previous: 41_200 },
      { label: 'likes', current: null, previous: 120 },
    ],
    topPosts: [{ text: 'x', engagement: 312 }],
    unavailable: ['likes'],
  };

  it('accepts figures that come from the data, in common formats', () => {
    expect(numbersIn('Views rose to 48,600 (48.6k) from 41.2k.')).toEqual([48600, 48.6, 41.2]);
    expect(
      explanationIsGrounded(
        'Views rose from 41,200 to 48,600; the best post had 312 interactions.',
        input,
      ),
    ).toBe(true);
    expect(explanationIsGrounded('October 1 to 31 went well across 3 posts.', input)).toBe(true);
  });

  it('refuses a number the model computed or invented', () => {
    expect(explanationIsGrounded('Views grew 18% month on month.', input)).toBe(false);
    expect(explanationIsGrounded('Likes reached 500.', input)).toBe(false);
  });
});

describe('GeminiProvider research', () => {
  const respond = (body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

  it('takes sources from the grounding metadata and asks for Google Search', async () => {
    let sent: { tools?: unknown } = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as { tools?: unknown };
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: 'Summary. See https://made-up.example' }] },
              finishReason: 'STOP',
              groundingMetadata: {
                webSearchQueries: ['vietnamese founders usa'],
                groundingChunks: [
                  { web: { uri: 'https://source.example/a', title: 'Source A' } },
                  { web: { uri: 'https://source.example/a', title: 'Duplicate' } },
                  { web: { uri: 'http://insecure.example', title: 'Insecure' } },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const provider = new GeminiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const result = await provider.researchTopic({
      question: 'Trends?',
      brand: null,
      correlationId: 'c',
    });
    expect(sent.tools).toEqual([{ google_search: {} }]);
    expect(result.value.sources).toEqual([{ title: 'Source A', url: 'https://source.example/a' }]);
    expect(result.value.searchQueries).toEqual(['vietnamese founders usa']);
  });

  it('refuses an answer that has no source', async () => {
    const provider = new GeminiProvider({
      apiKey: 'k',
      model: 'm',
      fetchImpl: respond({
        candidates: [{ content: { parts: [{ text: 'Trust me.' }] }, finishReason: 'STOP' }],
      }),
    });
    await expect(
      provider.researchTopic({ question: 'Trends?', brand: null, correlationId: 'c' }),
    ).rejects.toThrow(/no sources/i);
  });
});
