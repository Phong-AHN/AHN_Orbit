import { describe, expect, it } from 'vitest';
import { platformName, safeExternalUrl } from './links';

describe('safeExternalUrl', () => {
  it('keeps a web address', () => {
    expect(safeExternalUrl('https://www.youtube.com/watch?v=1rLDEnzKIRs')).toBe(
      'https://www.youtube.com/watch?v=1rLDEnzKIRs',
    );
    expect(safeExternalUrl('http://example.com/p')).toBe('http://example.com/p');
  });

  /** A typed-in link reaches an href; a script URL must not. */
  it('refuses anything that is not http or https', () => {
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('data:text/html,<script>1</script>')).toBeNull();
    expect(safeExternalUrl('mailto:someone@example.com')).toBeNull();
  });

  it('refuses nothing and nonsense', () => {
    expect(safeExternalUrl(null)).toBeNull();
    expect(safeExternalUrl('')).toBeNull();
    expect(safeExternalUrl('not a url')).toBeNull();
  });
});

describe('platformName', () => {
  it('spells the brands the way they spell themselves', () => {
    expect(platformName('YOUTUBE')).toBe('YouTube');
    expect(platformName('TIKTOK')).toBe('TikTok');
    expect(platformName('LINKEDIN')).toBe('LinkedIn');
    expect(platformName('MASTODON')).toBe('Mastodon');
  });
});
