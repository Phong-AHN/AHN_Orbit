import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { convertImage, derivedImageKeys, getDerivedStorageKey } from './convert.js';

describe('getDerivedStorageKey', () => {
  it('replaces original filename with derived variant', () => {
    const key = 'org/018ff/workspace/018ff/2026/11/018ff/original.png';
    expect(getDerivedStorageKey(key, 'converted-jpeg', 'jpg')).toBe(
      'org/018ff/workspace/018ff/2026/11/018ff/converted-jpeg.jpg',
    );
  });

  it('handles flat keys without folders', () => {
    expect(getDerivedStorageKey('original.png', 'converted-jpeg', 'jpg')).toBe(
      'converted-jpeg.jpg',
    );
  });
});

describe('derivedImageKeys', () => {
  it('names every derivative, in the original’s own folder, for deletion with it', () => {
    const key = 'org/018ff/workspace/018ff/2026/11/018ff/original.png';
    expect(derivedImageKeys(key)).toEqual([
      'org/018ff/workspace/018ff/2026/11/018ff/converted-jpeg.jpg',
      'org/018ff/workspace/018ff/2026/11/018ff/converted-png.png',
    ]);
  });
});

describe('convertImage', () => {
  it('converts PNG to JPEG and flattens transparency to white', async () => {
    // Create a 20x20 semi-transparent red PNG
    const testPng = await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer();

    const result = await convertImage(testPng, { format: 'jpeg', quality: 85 });

    expect(result.mimeType).toBe('image/jpeg');
    expect(result.extension).toBe('jpg');
    expect(result.width).toBe(20);
    expect(result.height).toBe(20);
    expect(result.sizeBytes).toBeGreaterThan(0);

    // Verify output is a valid JPEG
    const meta = await sharp(result.bytes).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.channels).toBe(3); // Flattened: no alpha channel
    expect(meta.space).toBe('srgb');
  });

  it('respects maxDimension resize constraint', async () => {
    const testPng = await sharp({
      create: {
        width: 200,
        height: 100,
        channels: 3,
        background: { r: 0, g: 128, b: 0 },
      },
    })
      .png()
      .toBuffer();

    const result = await convertImage(testPng, { format: 'jpeg', maxDimension: 50 });

    expect(result.width).toBe(50);
    expect(result.height).toBe(25);
  });
});
