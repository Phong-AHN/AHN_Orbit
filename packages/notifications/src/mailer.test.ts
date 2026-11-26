import { describe, expect, it } from 'vitest';
import { formatSender } from './mailer.js';

/** The From line an inbox shows (D-129). It ends up in a header, so it is careful. */
describe('the sender', () => {
  it('shows the product name beside the address', () => {
    expect(formatSender('Social Square', 'socialsquare@ahnmedia.com')).toBe(
      'Social Square <socialsquare@ahnmedia.com>',
    );
  });

  it('falls back to the bare address without a name', () => {
    expect(formatSender(undefined, 'socialsquare@ahnmedia.com')).toBe('socialsquare@ahnmedia.com');
    expect(formatSender('   ', 'socialsquare@ahnmedia.com')).toBe('socialsquare@ahnmedia.com');
  });

  it('quotes a name that would otherwise read as address syntax', () => {
    expect(formatSender('AHN, Media', 'a@b.co')).toBe('"AHN, Media" <a@b.co>');
    expect(formatSender('Say "hi"', 'a@b.co')).toBe('"Say \\"hi\\"" <a@b.co>');
  });

  it('cannot start a second header', () => {
    expect(formatSender('Social Square\r\nBcc: x@evil.test', 'a@b.co')).not.toMatch(/[\r\n]/);
  });
});
