import { describe, expect, it } from 'vitest';
import { isReservedSlug, slugify, uniqueSlug } from './slug';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Northwind Coffee')).toBe('northwind-coffee');
  });

  it('strips accents rather than dropping the letters', () => {
    expect(slugify('Café Ünion')).toBe('cafe-union');
  });

  it('collapses punctuation and trims stray hyphens', () => {
    expect(slugify('  ***Acme & Co.***  ')).toBe('acme-co');
  });

  it('caps length without leaving a trailing hyphen', () => {
    const slug = slugify('a'.repeat(40) + ' ' + 'b'.repeat(40));
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('returns empty for input with nothing usable, so a fallback is applied', () => {
    expect(slugify('***')).toBe('');
    expect(slugify('')).toBe('');
    expect(slugify('a')).toBe('');
  });
});

describe('isReservedSlug', () => {
  it.each(['api', 'admin', 'portal', 'auth', '_next', 'settings'])('reserves %s', (slug) => {
    expect(isReservedSlug(slug)).toBe(true);
  });

  it('allows an ordinary name', () => {
    expect(isReservedSlug('northwind-coffee')).toBe(false);
  });
});

describe('uniqueSlug', () => {
  it('returns the base when it is free', async () => {
    expect(await uniqueSlug('Northwind Coffee', async () => false)).toBe('northwind-coffee');
  });

  it('appends a counter when taken', async () => {
    const taken = new Set(['acme', 'acme-2']);
    expect(await uniqueSlug('Acme', async (c) => taken.has(c))).toBe('acme-3');
  });

  it('skips reserved words entirely', async () => {
    // "Admin" slugifies to a reserved slug, so the first candidate is skipped.
    expect(await uniqueSlug('Admin', async () => false)).toBe('admin-2');
  });

  it('uses the fallback when the name yields nothing', async () => {
    expect(await uniqueSlug('***', async () => false, 'brand')).toBe('brand');
  });
});
