/**
 * Injectable clock.
 *
 * Scheduling, token expiry, retry backoff, and rate-limit windows are all
 * time-dependent, and none of them can be tested honestly against the wall
 * clock. Application code calls `clock.now()`; `new Date()` is banned by lint
 * so nothing quietly reintroduces an untestable dependency on real time.
 */
export interface Clock {
  now(): Date;
  nowMs(): number;
}

export const systemClock: Clock = {
  now: () => new Date(Date.now()),
  nowMs: () => Date.now(),
};

/** A clock frozen at a point in time, advanceable by hand. For tests. */
export function fixedClock(start: Date | number = 0): Clock & { advance(ms: number): void } {
  let current = typeof start === 'number' ? start : start.getTime();
  return {
    now: () => new Date(current),
    nowMs: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

let active: Clock = systemClock;

export const clock: Clock = {
  now: () => active.now(),
  nowMs: () => active.nowMs(),
};

/** Swap the ambient clock. Returns a restore function. Test-only. */
export function setClock(next: Clock): () => void {
  const previous = active;
  active = next;
  return () => {
    active = previous;
  };
}
