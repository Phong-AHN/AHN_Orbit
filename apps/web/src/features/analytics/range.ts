import { ValidationError, clock } from '@orbit/core';
import type { AnalyticsRange } from './service';

/**
 * Reading a date window off a query string.
 *
 * Shared by all three analytics endpoints so they cannot disagree about what
 * `?from=` means — a window that shifted by an endpoint would make two views of
 * the same period show different numbers, which is the kind of bug an agency
 * discovers in front of a client.
 */

/** The default window when none is asked for. */
const DEFAULT_DAYS = 30;

/**
 * The longest window a single request may ask for.
 *
 * Retention is thirteen months, so this is not about what exists — it is about
 * one request not sweeping a year of rows for every account at once.
 */
const MAX_DAYS = 400;

export function parseRange(params: URLSearchParams): AnalyticsRange {
  const now = clock.now();

  const to = parseDate(params.get('to')) ?? now;
  const from = parseDate(params.get('from')) ?? new Date(to.getTime() - DEFAULT_DAYS * DAY_MS);

  if (from > to) {
    throw new ValidationError('The start of the range is after its end', {
      userMessage: 'That date range starts after it ends.',
    });
  }

  if (to.getTime() - from.getTime() > MAX_DAYS * DAY_MS) {
    throw new ValidationError(`Range exceeds ${MAX_DAYS} days`, {
      userMessage: `Ask for ${MAX_DAYS} days or fewer at a time.`,
    });
  }

  return { from, to };
}

const DAY_MS = 24 * 60 * 60 * 1_000;

/** `undefined` for absent, and a refusal for present-but-unparseable. */
function parseDate(value: string | null): Date | undefined {
  if (!value) return undefined;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(`Unparseable date: ${value}`, {
      userMessage: 'That date could not be read. Use YYYY-MM-DD.',
    });
  }

  return parsed;
}
