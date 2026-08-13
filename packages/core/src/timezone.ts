import { ValidationError } from './errors.js';

/**
 * IANA timezone arithmetic (SRS §36, assumption C5).
 *
 * Built on `Intl.DateTimeFormat`, which Node ships with full ICU — so the DST
 * rules come from the tz database and stay current with Node, rather than from
 * a dependency we would have to remember to update. No library needed for what
 * we actually do: convert a wall-clock time in a zone to a UTC instant, and
 * back.
 *
 * Everything is stored UTC. A zone appears only when a human expresses an
 * intent ("9am Tuesday") or reads one back.
 *
 * ## The two DST cases, which are not symmetric
 *
 * **Spring forward** leaves a *gap*: on the day clocks jump 02:00 → 03:00,
 * 02:30 does not exist. There is no instant to convert it to.
 *
 * **Autumn back** leaves an *overlap*: 01:30 happens twice, once at each
 * offset. There are two instants and they are an hour apart.
 *
 * Callers say what they want to happen — see `NonexistentTimePolicy` and
 * `AmbiguousTimePolicy`, and decision D-023 for why the defaults differ between
 * a time a user picked and a recurring queue slot.
 */

export interface WallClock {
  year: number;
  /** 1–12, not the 0-based nonsense `Date` uses. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second?: number;
}

/** What to do when the wall time does not exist (spring-forward gap). */
export type NonexistentTimePolicy =
  /** Throw. Right for a time a person explicitly chose — they should re-pick. */
  | 'REJECT'
  /** Take the first instant after the gap. Right for a recurring slot. */
  | 'SHIFT_FORWARD';

/** What to do when the wall time happens twice (autumn-back overlap). */
export type AmbiguousTimePolicy =
  /** The earlier of the two. Publishing early beats publishing late. */
  'EARLIER' | 'LATER';

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** True when the runtime recognises this IANA zone. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function assertValidTimeZone(timeZone: string): void {
  if (!isValidTimeZone(timeZone)) {
    throw new ValidationError(`Unknown IANA timezone: ${timeZone}`, {
      userMessage: "That timezone isn't one we recognise.",
      details: [{ field: 'timezone', issue: 'must be an IANA zone such as Asia/Ho_Chi_Minh' }],
    });
  }
}

/** What the clock on the wall reads, in `timeZone`, at instant `date`. */
export function toWallClock(date: Date, timeZone: string): Required<WallClock> {
  const parts = formatterFor(timeZone).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

/**
 * The zone's offset from UTC, in ms, at a given instant.
 *
 * Derived by formatting the instant in the zone and comparing to the same
 * fields read as UTC — which is exactly what the offset is, and avoids parsing
 * zone abbreviations (ambiguous: "CST" is three different things).
 */
export function offsetAt(date: Date, timeZone: string): number {
  const wall = toWallClock(date, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  // Seconds resolution is all `formatToParts` gives; drop sub-second drift.
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

export interface ZonedConversion {
  instant: Date;
  /** True when the requested wall time did not exist and was shifted. */
  shifted: boolean;
  /** True when the requested wall time occurred twice. */
  ambiguous: boolean;
}

/**
 * Every UTC instant that reads as this wall time in this zone.
 *
 * The count *is* the classification: zero means the time falls in a
 * spring-forward gap, one is the ordinary case, two means an autumn-back
 * overlap. Deriving it this way rather than by inspecting transitions means
 * there is no direction to get backwards — an earlier attempt probed only
 * forward from its first guess and so missed overlaps whose first guess had
 * already landed on the *later* occurrence.
 *
 * The candidate offsets are sampled a day either side, which is far wider than
 * any real transition (the largest ever was 24 hours, when Samoa skipped a
 * calendar day; ordinary DST is 30 or 60 minutes).
 */
function occurrencesOf(wall: WallClock, timeZone: string): Date[] {
  const naive = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second ?? 0,
  );

  const probes = [naive - 86_400_000, naive, naive + 86_400_000];
  const offsets = [...new Set(probes.map((probe) => offsetAt(new Date(probe), timeZone)))];

  const found = offsets
    .map((offset) => naive - offset)
    .filter((candidate) => wallClockEquals(toWallClock(new Date(candidate), timeZone), wall));

  return [...new Set(found)].sort((a, b) => a - b).map((time) => new Date(time));
}

/**
 * Convert a wall-clock time in a zone to the UTC instant it names.
 *
 * Around a DST transition a wall time may name two instants or none, so the
 * caller's policies decide what happens — see `NonexistentTimePolicy` and
 * `AmbiguousTimePolicy`.
 */
export function zonedTimeToUtc(
  wall: WallClock,
  timeZone: string,
  options: {
    nonexistent?: NonexistentTimePolicy;
    ambiguous?: AmbiguousTimePolicy;
  } = {},
): ZonedConversion {
  assertValidTimeZone(timeZone);

  const nonexistent = options.nonexistent ?? 'REJECT';
  const ambiguousPolicy = options.ambiguous ?? 'EARLIER';

  const occurrences = occurrencesOf(wall, timeZone);

  if (occurrences.length === 1) {
    return { instant: occurrences[0] as Date, shifted: false, ambiguous: false };
  }

  if (occurrences.length > 1) {
    const earlier = occurrences[0] as Date;
    const later = occurrences[occurrences.length - 1] as Date;

    return {
      instant: ambiguousPolicy === 'EARLIER' ? earlier : later,
      shifted: false,
      ambiguous: true,
    };
  }

  // No occurrence: the wall time falls in a gap.
  if (nonexistent === 'REJECT') {
    throw new ValidationError(
      `Wall-clock time does not exist in ${timeZone} (daylight saving gap)`,
      {
        userMessage:
          "That time doesn't exist on that date — the clocks go forward. Pick a time before or after the change.",
        details: [{ field: 'scheduledFor', issue: 'falls in a daylight saving gap' }],
        context: { timeZone, wall },
      },
    );
  }

  // SHIFT_FORWARD: the first instant the zone actually reaches at or after the
  // requested time. Converting with the offset in force *before* the gap lands
  // past it, which is exactly the transition moment.
  const naive = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second ?? 0,
  );
  const offsetBefore = offsetAt(new Date(naive - 86_400_000), timeZone);

  return { instant: new Date(naive - offsetBefore), shifted: true, ambiguous: false };
}

function wallClockEquals(a: Required<WallClock>, b: WallClock): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === (b.second ?? 0)
  );
}

/** Parse `"HH:MM"` as used by `QueueSlot.localTime`. */
export function parseLocalTime(value: string): { hour: number; minute: number } {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new ValidationError(`Invalid local time: ${value}`, {
      userMessage: 'Times must look like 09:30.',
      details: [{ field: 'localTime', issue: 'expected HH:MM' }],
    });
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (hour > 23 || minute > 59) {
    throw new ValidationError(`Invalid local time: ${value}`, {
      userMessage: 'Times must look like 09:30, between 00:00 and 23:59.',
      details: [{ field: 'localTime', issue: 'hour or minute out of range' }],
    });
  }

  return { hour, minute };
}

/** Render an instant in a zone, for display. */
export function formatInZone(
  date: Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = {},
): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
    ...options,
  }).format(date);
}

/**
 * Whether two zones read the same at an instant.
 *
 * Drives assumption C5's rule that the UI shows both zones **only when they
 * differ** — comparing the rendered wall time rather than the zone names, so
 * `Europe/London` and `Europe/Dublin` do not produce noise in winter.
 */
export function zonesAgreeAt(date: Date, a: string, b: string): boolean {
  if (a === b) return true;
  return offsetAt(date, a) === offsetAt(date, b);
}

/** Day boundaries in a zone, as UTC instants. For calendar range queries. */
export function zonedDayRange(
  wall: Pick<WallClock, 'year' | 'month' | 'day'>,
  timeZone: string,
): { start: Date; end: Date } {
  const start = zonedTimeToUtc(
    { ...wall, hour: 0, minute: 0, second: 0 },
    timeZone,
    // Midnight is exactly what some zones skip on a DST day, so a day range
    // must never reject — it shifts to the first moment the day has.
    { nonexistent: 'SHIFT_FORWARD' },
  ).instant;

  const nextDay = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + 1));
  const end = zonedTimeToUtc(
    {
      year: nextDay.getUTCFullYear(),
      month: nextDay.getUTCMonth() + 1,
      day: nextDay.getUTCDate(),
      hour: 0,
      minute: 0,
      second: 0,
    },
    timeZone,
    { nonexistent: 'SHIFT_FORWARD' },
  ).instant;

  return { start, end };
}
