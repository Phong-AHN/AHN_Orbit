import { describe, expect, it } from 'vitest';
import {
  SLIDE_DRAG_TYPE,
  attachmentLimits,
  collectUploaded,
  isFileDrag,
  moveItem,
  runWithConcurrency,
} from './upload-plan';

describe('moveItem', () => {
  const slides = ['a', 'b', 'c', 'd'];

  it('moves a slide later', () => {
    expect(moveItem(slides, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves a slide earlier', () => {
    expect(moveItem(slides, 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  /** A drag past the end means "last"; a press at either end does nothing. */
  it('clamps rather than throwing', () => {
    expect(moveItem(slides, 1, 99)).toEqual(['a', 'c', 'd', 'b']);
    expect(moveItem(slides, 0, -1)).toEqual(slides);
    expect(moveItem(slides, 3, 4)).toEqual(slides);
  });

  it('never mutates its input', () => {
    const input = ['a', 'b'];
    moveItem(input, 0, 1);
    expect(input).toEqual(['a', 'b']);
  });

  it('ignores an index that is not there', () => {
    expect(moveItem(slides, 9, 0)).toEqual(slides);
  });
});

describe('runWithConcurrency', () => {
  /**
   * The point of the whole helper. Uploads finish in network order; a carousel
   * must keep the order the slides were chosen in.
   */
  it('keeps results in input order however they finish', async () => {
    const delays = [40, 5, 20, 1];
    const results = await runWithConcurrency(delays, 3, async (ms, index) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return index;
    });

    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([0, 1, 2, 3]);
  });

  it('never runs more than the limit at once', async () => {
    let inFlight = 0;
    let peak = 0;

    await runWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
    });

    expect(peak).toBe(3);
  });

  /** Seven good slides out of eight should still attach. */
  it('keeps going past a failure', async () => {
    const results = await runWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('rejected');
      return n;
    });

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });

  it('handles an empty batch', async () => {
    expect(await runWithConcurrency([], 3, async () => 1)).toEqual([]);
  });
});

describe('collectUploaded', () => {
  it('keeps successes in order and drops failures and rejected files', () => {
    const results: Array<PromiseSettledResult<string | null>> = [
      { status: 'fulfilled', value: 'a' },
      { status: 'rejected', reason: new Error('network') },
      // Uploaded, but the server refused the bytes.
      { status: 'fulfilled', value: null },
      { status: 'fulfilled', value: 'd' },
    ];

    expect(collectUploaded(results)).toEqual(['a', 'd']);
  });
});

describe('attachmentLimits', () => {
  const limits = [
    { platform: 'INSTAGRAM', max: 10 },
    { platform: 'THREADS', max: 20 },
  ];

  /** Instagram's 10 binds a post that also goes to Threads. */
  it('reports the lowest limit as the binding one', () => {
    expect(attachmentLimits(8, limits).binding).toEqual({ platform: 'INSTAGRAM', max: 10 });
  });

  it('lists every platform the count is over', () => {
    expect(attachmentLimits(12, limits).over).toEqual([{ platform: 'INSTAGRAM', max: 10 }]);
    expect(attachmentLimits(25, limits).over.map((l) => l.platform)).toEqual([
      'INSTAGRAM',
      'THREADS',
    ]);
  });

  /** Exactly at the limit is fine — ten slides is a legal Instagram carousel. */
  it('is not over at exactly the limit', () => {
    expect(attachmentLimits(10, limits).over).toEqual([]);
  });

  it('has nothing to say with no platforms', () => {
    expect(attachmentLimits(3, [])).toEqual({ binding: null, over: [] });
  });
});

describe('isFileDrag', () => {
  it('recognises files dragged from the desktop', () => {
    expect(isFileDrag(['Files'])).toBe(true);
  });

  /** A slide being moved must never be treated as an upload. */
  it('does not mistake a slide drag for a file', () => {
    expect(isFileDrag([SLIDE_DRAG_TYPE])).toBe(false);
    expect(isFileDrag(['Files', SLIDE_DRAG_TYPE])).toBe(false);
  });

  it('ignores a text drag', () => {
    expect(isFileDrag(['text/plain'])).toBe(false);
  });
});
