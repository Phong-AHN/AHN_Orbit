import { describe, expect, it } from 'vitest';
import { connectionLimitOf, withConnectionLimit } from './pool.js';

// Made-up credentials: the point is that they come through untouched.
const pooled =
  'postgresql://postgres.abc:p%40ss%2Fw0rd@aws-0-region.pooler.example.com:6543/postgres?pgbouncer=true&connection_limit=1';

describe('the database pool size', () => {
  it('replaces the URL’s connection_limit, keeping its other options', () => {
    const url = withConnectionLimit(pooled, 10);
    expect(connectionLimitOf(url)).toBe(10);
    expect(url).toContain('pgbouncer=true');
    expect(url.match(/connection_limit=/g)).toHaveLength(1);
  });

  it('never touches the part with the password', () => {
    const url = withConnectionLimit(pooled, 10);
    expect(url.startsWith(pooled.slice(0, pooled.indexOf('?') + 1))).toBe(true);
  });

  it('adds one to a URL that had no options', () => {
    const url = withConnectionLimit('postgresql://u:p@host:5432/db', 5);
    expect(url).toBe('postgresql://u:p@host:5432/db?connection_limit=5');
  });

  it('leaves the URL alone when no limit is set', () => {
    expect(withConnectionLimit(pooled, undefined)).toBe(pooled);
  });

  it('reads what a URL asks for, or nothing', () => {
    expect(connectionLimitOf(pooled)).toBe(1);
    expect(connectionLimitOf('postgresql://u:p@host/db')).toBeUndefined();
    expect(connectionLimitOf('postgresql://u:p@host/db?connection_limit=abc')).toBeUndefined();
  });
});
