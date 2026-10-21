/**
 * The decisions behind attaching several files at once and putting them in
 * order — pure, so they can be tested without a browser.
 *
 * Nobody has watched this panel work in a browser. The parts most likely to be
 * wrong are therefore kept here: which order the slides end up in when uploads
 * finish out of order, what happens when some of a batch fail, how a move is
 * clamped, and whether a drag is a file from the desktop or a slide being
 * moved. The panel itself is left as chrome around these.
 */

/**
 * Move one item, returning a new array.
 *
 * Clamped rather than throwing: a drag that ends past the last slide means
 * "put it last", and a keyboard press at either end is a no-op, not an error.
 */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length) return [...items];

  const target = Math.max(0, Math.min(items.length - 1, to));
  if (target === from) return [...items];

  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved as T);
  return next;
}

/**
 * Run `worker` over `inputs` with at most `limit` in flight, keeping results in
 * **input** order.
 *
 * The order matters more than it looks. Uploads finish in whatever order the
 * network allows — a small image overtakes a large one — and attaching them in
 * completion order would scramble a carousel somebody had already numbered.
 * The slides keep the order they were chosen in.
 *
 * Settled rather than rejected, so one failure does not abandon the rest of
 * the batch: seven good slides out of eight should still attach.
 */
export async function runWithConcurrency<T, R>(
  inputs: readonly T[],
  limit: number,
  worker: (input: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = new Array(inputs.length);
  const width = Math.max(1, Math.floor(limit));
  let cursor = 0;

  async function lane(): Promise<void> {
    while (cursor < inputs.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { status: 'fulfilled', value: await worker(inputs[index] as T, index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(width, inputs.length) }, () => lane()));
  return results;
}

/**
 * The successful results, in selection order, with failures dropped.
 *
 * A result may itself be `null` for a file that uploaded but failed
 * verification — the server rejected its bytes — and that is dropped too.
 */
export function collectUploaded<R>(results: ReadonlyArray<PromiseSettledResult<R | null>>): R[] {
  const out: R[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value !== null) out.push(result.value);
  }
  return out;
}

export interface PlatformLimit {
  platform: string;
  /** `maxAttachments` from the platform's capability descriptor. */
  max: number;
}

export interface LimitStatus {
  /** The lowest limit among the post's platforms — the one that binds. */
  binding: PlatformLimit | null;
  /** Every platform this many attachments is over. */
  over: PlatformLimit[];
}

/**
 * How a count of attachments sits against each target platform's limit.
 *
 * **A display aid, never a verdict.** It mirrors the character counter: a
 * number and a colour, so somebody preparing a ten-slide carousel sees the
 * ceiling before they hit it. Whether the post is publishable is still decided
 * by `/validate` on the server, which is why nothing here refuses anything.
 */
export function attachmentLimits(count: number, limits: readonly PlatformLimit[]): LimitStatus {
  if (limits.length === 0) return { binding: null, over: [] };

  const binding = limits.reduce((lowest, limit) => (limit.max < lowest.max ? limit : lowest));
  const over = limits.filter((limit) => count > limit.max);

  return { binding, over };
}

/** The MIME type a slide drag carries, so it is never mistaken for a file. */
export const SLIDE_DRAG_TYPE = 'application/x-orbit-slide';

/**
 * Whether a drag carries files from the desktop rather than a slide being moved.
 *
 * Both arrive as drag events on the same panel, and treating a reorder as an
 * upload — or a dropped file as a reorder — would be confusing at best. The
 * browser lists `Files` for a file drag; a slide drag carries our own type.
 */
export function isFileDrag(types: readonly string[]): boolean {
  return types.includes('Files') && !types.includes(SLIDE_DRAG_TYPE);
}
