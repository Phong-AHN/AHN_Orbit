import { describe, expect, it } from 'vitest';
import { replyWindow } from './messaging';

const HOUR = 60 * 60 * 1_000;
const inbound = new Date('2026-10-20T09:00:00.000Z');
const at = (hours: number) => new Date(inbound.getTime() + hours * HOUR);

const standard = { standardHours: 24 };
const withAgent = { standardHours: 24, humanAgentHours: 168 };

describe('replyWindow', () => {
  it('is open inside the standard window, and says when it closes', () => {
    expect(replyWindow({ lastInboundAt: inbound, now: at(23), rules: standard })).toEqual({
      state: 'OPEN',
      closesAt: at(24),
    });
  });

  /** The boundary belongs to the closed side: at 24h exactly, the platform refuses. */
  it('closes at the standard boundary without the human-agent tag', () => {
    expect(replyWindow({ lastInboundAt: inbound, now: at(24), rules: standard })).toEqual({
      state: 'CLOSED',
      closesAt: null,
    });
  });

  it('falls into the human-agent window when the app may use it', () => {
    expect(replyWindow({ lastInboundAt: inbound, now: at(30), rules: withAgent })).toEqual({
      state: 'HUMAN_AGENT',
      closesAt: at(168),
    });
  });

  it('closes after the human-agent window too', () => {
    expect(replyWindow({ lastInboundAt: inbound, now: at(168), rules: withAgent }).state).toBe(
      'CLOSED',
    );
  });

  /** Writing first is the thing the rule forbids. */
  it('is closed when the person has never written', () => {
    expect(replyWindow({ lastInboundAt: null, now: at(1), rules: withAgent })).toEqual({
      state: 'CLOSED',
      closesAt: null,
    });
  });

  /** A misconfigured extension must not shorten or confuse the standard window. */
  it('ignores a human-agent window no longer than the standard one', () => {
    const rules = { standardHours: 24, humanAgentHours: 12 };
    expect(replyWindow({ lastInboundAt: inbound, now: at(20), rules }).state).toBe('OPEN');
    expect(replyWindow({ lastInboundAt: inbound, now: at(25), rules }).state).toBe('CLOSED');
  });
});
