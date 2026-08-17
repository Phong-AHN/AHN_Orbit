import { describe, expect, it } from 'vitest';
import { ValidationError } from '@orbit/core';
import { UnsupportedMediaError, declaredTypeMatches, sniff, trySniff } from './sniff.js';
import { probeMedia } from './probe.js';
import { assertKeyBelongsTo, buildObjectKey, sanitiseFilename } from './keys.js';

/**
 * Byte-level media verification.
 *
 * Fixtures are built here rather than committed as binaries, so every test
 * states exactly which bytes it depends on — and a reader can see that the
 * dimension assertions come from the header fields, not from a filename.
 */

// ── Fixture builders ────────────────────────────────────────────────────────

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function jpeg(width: number, height: number, { withExif = false } = {}): Uint8Array {
  const parts: number[] = [0xff, 0xd8]; // SOI

  if (withExif) {
    // An APP1/EXIF segment claiming nothing useful — the parser must skip it
    // and read the real dimensions from the frame header instead.
    const payload = new Array(20).fill(0x00);
    parts.push(0xff, 0xe1, 0x00, payload.length + 2, ...payload);
  }

  // SOF0: marker, length, precision, height, width, components
  parts.push(0xff, 0xc0, 0x00, 0x11, 0x08);
  parts.push((height >> 8) & 0xff, height & 0xff);
  parts.push((width >> 8) & 0xff, width & 0xff);
  parts.push(0x03, ...new Array(9).fill(0x00));

  return new Uint8Array(parts);
}

function gif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // GIF89a
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

function webpLossy(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(40);
  const view = new DataView(bytes.buffer);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  bytes.set([0x56, 0x50, 0x38, 0x20], 12); // "VP8 "
  view.setUint16(26, width, true);
  view.setUint16(28, height, true);
  return bytes;
}

function mp4(durationSeconds: number, width = 1920, height = 1080): Uint8Array {
  const boxes: number[] = [];

  const push32 = (target: number[], value: number) =>
    target.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  const pushType = (target: number[], type: string) => {
    for (const ch of type) target.push(ch.charCodeAt(0));
  };

  // ftyp — 16 bytes: size, type, major brand, minor version.
  push32(boxes, 16);
  pushType(boxes, 'ftyp');
  pushType(boxes, 'isom');
  push32(boxes, 512);

  // mvhd (version 0): 108 bytes total
  const mvhd: number[] = [];
  push32(mvhd, 108);
  pushType(mvhd, 'mvhd');
  mvhd.push(0, 0, 0, 0); // version + flags
  push32(mvhd, 0); // creation
  push32(mvhd, 0); // modification
  push32(mvhd, 1000); // timescale
  push32(mvhd, durationSeconds * 1000); // duration
  while (mvhd.length < 108) mvhd.push(0);

  // tkhd (version 0): 92 bytes, width/height as 16.16 fixed point at the end
  const tkhd: number[] = [];
  push32(tkhd, 92);
  pushType(tkhd, 'tkhd');
  tkhd.push(0, 0, 0, 0);
  while (tkhd.length < 92 - 8) tkhd.push(0);
  push32(tkhd, width * 65_536);
  push32(tkhd, height * 65_536);

  const trak: number[] = [];
  push32(trak, 8 + tkhd.length);
  pushType(trak, 'trak');
  trak.push(...tkhd);

  const moov: number[] = [];
  push32(moov, 8 + mvhd.length + trak.length);
  pushType(moov, 'moov');
  moov.push(...mvhd, ...trak);

  return new Uint8Array([...boxes, ...moov]);
}

/**
 * The layout a phone or an editor actually produces.
 *
 * `moov` sits at the **end**, after the media data, unless fast-start was
 * applied. `mp4()` above puts it at the front, which is the easy case and the
 * only one the suite used to cover.
 */
function mp4WithTrailingMoov(durationSeconds: number, mdatBytes: number): Uint8Array {
  const aligned = mp4(durationSeconds);

  // Everything up to `moov` in the fast-start file is the header; the rest is
  // the movie box we are relocating.
  const moovAt = indexOfType(aligned, 'moov') - 4;
  const header = aligned.slice(0, moovAt);
  const moov = aligned.slice(moovAt);

  // An `mdat` box of arbitrary size standing in for the video frames. Filled
  // with a repeating pattern rather than zeroes so a false-positive scan has
  // something to trip over.
  const mdat = new Uint8Array(mdatBytes);
  const view = new DataView(mdat.buffer);
  view.setUint32(0, mdatBytes);
  mdat.set([0x6d, 0x64, 0x61, 0x74], 4);
  for (let i = 8; i < mdatBytes; i += 1) mdat[i] = i % 251;

  const out = new Uint8Array(header.length + mdat.length + moov.length);
  out.set(header, 0);
  out.set(mdat, header.length);
  out.set(moov, header.length + mdat.length);
  return out;
}

function indexOfType(bytes: Uint8Array, type: string): number {
  const codes = [...type].map((ch) => ch.charCodeAt(0));
  for (let i = 0; i + 4 <= bytes.length; i += 1) {
    if (codes.every((code, k) => bytes[i + k] === code)) return i;
  }
  return -1;
}

/**
 * An `ftyp` box with an unusual major brand and a familiar compatible one.
 *
 * This is the shape a camera or an editor produces: something vendor-specific
 * in the major slot, `isom`/`mp42` in the compatible list — which is precisely
 * what the compatible list is for.
 */
function mp4WithBrands(major: string, compatible: string[]): Uint8Array {
  const boxSize = 16 + compatible.length * 4;
  const bytes = new Uint8Array(Math.max(64, boxSize));
  const view = new DataView(bytes.buffer);

  view.setUint32(0, boxSize);
  bytes.set(
    [...'ftyp'].map((c) => c.charCodeAt(0)),
    4,
  );
  bytes.set(
    [...major].map((c) => c.charCodeAt(0)),
    8,
  );
  view.setUint32(12, 512);
  compatible.forEach((brand, index) => {
    bytes.set(
      [...brand].map((c) => c.charCodeAt(0)),
      16 + index * 4,
    );
  });

  return bytes;
}

/**
 * An MP4 carrying a real sample table.
 *
 * `stts` is a run-length list of `(sample_count, sample_delta)` in the track's
 * timescale. One entry is a constant frame rate; several distinct deltas is
 * variable frame rate — which is what a phone records by default, and what
 * TikTok rejects while the file's own label still says 30fps.
 */
function mp4WithSampleTable(
  timescale: number,
  entries: Array<[count: number, delta: number]>,
  handler = 'vide',
): Uint8Array {
  const out: number[] = [];
  const push32 = (t: number[], v: number) =>
    t.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  const pushType = (t: number[], s: string) => {
    for (const ch of s) t.push(ch.charCodeAt(0));
  };

  const box = (type: string, payload: number[]): number[] => {
    const b: number[] = [];
    push32(b, 8 + payload.length);
    pushType(b, type);
    b.push(...payload);
    return b;
  };

  // ftyp
  push32(out, 16);
  pushType(out, 'ftyp');
  pushType(out, 'isom');
  push32(out, 512);

  const mvhd: number[] = [];
  mvhd.push(0, 0, 0, 0);
  push32(mvhd, 0);
  push32(mvhd, 0);
  push32(mvhd, 1000);
  push32(mvhd, 4000);
  while (mvhd.length < 100) mvhd.push(0);

  // hdlr: version+flags, predefined, then handler_type.
  const hdlr: number[] = [];
  hdlr.push(0, 0, 0, 0);
  push32(hdlr, 0);
  pushType(hdlr, handler);
  while (hdlr.length < 24) hdlr.push(0);

  // mdhd v0: version+flags, creation, modification, timescale, duration.
  const mdhd: number[] = [];
  mdhd.push(0, 0, 0, 0);
  push32(mdhd, 0);
  push32(mdhd, 0);
  push32(mdhd, timescale);
  push32(mdhd, timescale * 4);
  while (mdhd.length < 24) mdhd.push(0);

  const stts: number[] = [];
  stts.push(0, 0, 0, 0);
  push32(stts, entries.length);
  for (const [count, delta] of entries) {
    push32(stts, count);
    push32(stts, delta);
  }

  const stbl = box('stbl', box('stts', stts));
  const minf = box('minf', stbl);
  const mdia = box('mdia', [...box('hdlr', hdlr), ...box('mdhd', mdhd), ...minf]);
  const trak = box('trak', mdia);
  const moov = box('moov', [...box('mvhd', mvhd), ...trak]);

  return new Uint8Array([...out, ...moov]);
}

// ── Sniffing ────────────────────────────────────────────────────────────────

describe('sniff — identifies real types', () => {
  it.each([
    ['PNG', png(10, 10), 'image/png', 'IMAGE'],
    ['JPEG', jpeg(10, 10), 'image/jpeg', 'IMAGE'],
    ['GIF', gif(10, 10), 'image/gif', 'GIF'],
    ['WebP', webpLossy(10, 10), 'image/webp', 'IMAGE'],
    ['MP4', mp4(5), 'video/mp4', 'VIDEO'],
  ])('detects %s', (_label, bytes, mimeType, kind) => {
    const result = sniff(bytes);
    expect(result.mimeType).toBe(mimeType);
    expect(result.kind).toBe(kind);
  });

  it('classes GIF separately from other images, since platforms treat it differently', () => {
    expect(sniff(gif(1, 1)).kind).toBe('GIF');
    expect(sniff(png(1, 1)).kind).toBe('IMAGE');
  });

  it('derives the extension from the bytes, never from a filename', () => {
    expect(sniff(png(1, 1)).extension).toBe('png');
    expect(sniff(jpeg(1, 1)).extension).toBe('jpg');
  });
});

describe('sniff — refuses dangerous content', () => {
  const text = (s: string) => new TextEncoder().encode(s);

  it('REJECTS SVG, which is a script host disguised as an image', () => {
    expect(() => sniff(text('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'))).toThrow(
      /SVG/,
    );
  });

  it('rejects SVG behind an XML declaration or comment', () => {
    expect(() => sniff(text('<?xml version="1.0"?><svg width="1"></svg>'))).toThrow(/SVG/);
    expect(() => sniff(text('<!-- hi --><svg></svg>'))).toThrow(/SVG/);
  });

  it.each([
    ['HTML', '<!DOCTYPE html><html><body>x'],
    ['bare script', '<script>alert(1)</script>'],
    ['shell script', '#!/bin/sh\nrm -rf /'],
    ['Windows executable', 'MZ\x90\x00\x03'],
    ['ZIP archive', 'PK\x03\x04rest'],
  ])('rejects %s', (_label, content) => {
    expect(() => sniff(text(content))).toThrow(UnsupportedMediaError);
  });

  it('rejects an ELF binary', () => {
    const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
    expect(() => sniff(elf)).toThrow(UnsupportedMediaError);
  });

  it('rejects an unrecognised format rather than storing it hopefully', () => {
    expect(() => sniff(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]))).toThrow(
      /could not be identified/,
    );
  });

  it('rejects an empty buffer', () => {
    expect(() => sniff(new Uint8Array(0))).toThrow(UnsupportedMediaError);
  });

  it('rejects a PHP file renamed to look like an image', () => {
    // The motivating attack: the extension and declared type say image/jpeg,
    // and the bytes say otherwise.
    expect(() => sniff(text('<?php system($_GET["c"]); ?>'))).toThrow(UnsupportedMediaError);
  });

  it('trySniff returns undefined instead of throwing', () => {
    expect(trySniff(new Uint8Array([0, 1, 2]))).toBeUndefined();
    expect(trySniff(png(1, 1))?.mimeType).toBe('image/png');
  });
});

describe('declaredTypeMatches', () => {
  it('accepts an exact match and the image/jpg variant', () => {
    expect(declaredTypeMatches('image/jpeg', 'image/jpeg')).toBe(true);
    expect(declaredTypeMatches('image/jpg', 'image/jpeg')).toBe(true);
    expect(declaredTypeMatches('image/jpeg; charset=binary', 'image/jpeg')).toBe(true);
  });

  it('flags a mismatch, which is what a disguised upload looks like', () => {
    expect(declaredTypeMatches('image/jpeg', 'video/mp4')).toBe(false);
    expect(declaredTypeMatches(undefined, 'image/png')).toBe(false);
  });
});

// ── Probing ─────────────────────────────────────────────────────────────────

/**
 * Reading an MP4 whose `moov` is not at the front.
 *
 * This is what a 7-second clip off a phone looks like, and every one of them
 * was rejected as "damaged — we couldn't read its length". The probe reads the
 * head and, failing that, the **tail** — but a tail slice starts wherever
 * `size - window` lands, which is never a box boundary, so the walk read the
 * first four bytes as a nonsense box size and gave up immediately.
 */
describe('sniff — MP4 brands', () => {
  it('accepts a familiar major brand', () => {
    expect(sniff(mp4WithBrands('mp42', ['isom'])).mimeType).toBe('video/mp4');
  });

  /**
   * The case that rejects ordinary camera footage as an unknown format:
   * a vendor code in the major slot, with `isom` listed as compatible.
   */
  it('accepts an unfamiliar major brand that lists a familiar compatible one', () => {
    expect(sniff(mp4WithBrands('XAVC', ['isom', 'mp42'])).mimeType).toBe('video/mp4');
  });

  /** Still refuses when nothing recognisable appears anywhere. */
  it('refuses a container with no brand it knows', () => {
    expect(() => sniff(mp4WithBrands('zzzz', ['yyyy', 'xxxx']))).toThrow();
  });

  it('does not read past the ftyp box looking for a brand', () => {
    // A short box, with a familiar brand sitting *outside* it — beyond the box
    // is other data, not a brand list, and treating it as one would accept
    // anything with four lucky bytes.
    const bytes = mp4WithBrands('zzzz', []);
    bytes.set(
      [...'isom'].map((c) => c.charCodeAt(0)),
      32,
    );

    expect(() => sniff(bytes)).toThrow();
  });
});

/**
 * Frame rate, read from the sample table rather than believed from a label.
 *
 * A video rejected by TikTok for `frame_rate_check_failed` while its owner is
 * certain it is 30fps is almost always variable frame rate: the nominal figure
 * is 30 and the real gaps between frames vary, with peaks well past the 60fps
 * ceiling. Only the table says so.
 */
describe('probe — frame rate', () => {
  it('reads a constant 30fps', () => {
    // 600 ticks per second, one frame every 20 ticks → 30fps.
    const probe = probeMedia('video/mp4', mp4WithSampleTable(600, [[120, 20]]));

    expect(probe.frameRate).toBe(30);
    expect(probe.peakFrameRate).toBe(30);
    expect(probe.variableFrameRate).toBe(false);
  });

  /** The case that gets a "30fps" video refused. */
  it('sees through a variable rate whose average still looks like 30', () => {
    // Half the frames at 20 ticks (30fps), half at 5 ticks (120fps).
    const probe = probeMedia(
      'video/mp4',
      mp4WithSampleTable(600, [
        [60, 20],
        [60, 5],
      ]),
    );

    expect(probe.variableFrameRate).toBe(true);
    // The average is unremarkable...
    expect(probe.frameRate).toBeLessThan(60);
    // ...and the peak is what a platform objects to.
    expect(probe.peakFrameRate).toBe(120);
  });

  it('reads the video track, not the sound track', () => {
    // A sound track's sample table has a completely different rate; using it
    // gives a plausible wrong number instead of an obvious failure.
    const probe = probeMedia('video/mp4', mp4WithSampleTable(44_100, [[1000, 1024]], 'soun'));

    expect(probe.frameRate).toBeUndefined();
  });

  it('says nothing rather than guessing when there is no sample table', () => {
    expect(probeMedia('video/mp4', mp4(7)).frameRate).toBeUndefined();
  });

  /** A length field is never trusted to size a loop. */
  it('survives a sample table that claims more entries than it holds', () => {
    const bytes = mp4WithSampleTable(600, [[120, 20]]);
    const at = indexOfType(bytes, 'stts');
    // Claim a million entries in a box that holds one.
    new DataView(bytes.buffer).setUint32(at + 8, 1_000_000);

    expect(() => probeMedia('video/mp4', bytes)).not.toThrow();
    expect(probeMedia('video/mp4', bytes).frameRate).toBe(30);
  });
});

describe('probe — MP4 with the movie box at the end', () => {
  it('reads the duration from a tail slice that starts mid-file', () => {
    const file = mp4WithTrailingMoov(7, 400_000);

    // Exactly what `probeIntrinsics` hands over: the last N bytes, cut at an
    // offset chosen by arithmetic rather than by structure.
    const tail = file.slice(file.length - 100_000);

    expect(probeMedia('video/mp4', tail)).toMatchObject({ durationMs: 7_000, complete: true });
  });

  it('still fails honestly when the movie box is not in the slice at all', () => {
    const file = mp4WithTrailingMoov(7, 400_000);
    // A window from the middle: real video data, no moov anywhere in it.
    const middle = file.slice(50_000, 150_000);

    expect(probeMedia('video/mp4', middle).complete).toBe(false);
  });

  it('does not regress the fast-start layout, where byte 0 is a box', () => {
    expect(probeMedia('video/mp4', mp4(12))).toMatchObject({
      durationMs: 12_000,
      width: 1920,
      complete: true,
    });
  });
});

describe('probe — dimensions come from the header', () => {
  it('reads PNG dimensions', () => {
    expect(probeMedia('image/png', png(1920, 1080))).toMatchObject({
      width: 1920,
      height: 1080,
      complete: true,
    });
  });

  it('reads JPEG dimensions from the frame header', () => {
    expect(probeMedia('image/jpeg', jpeg(800, 600))).toMatchObject({
      width: 800,
      height: 600,
      complete: true,
    });
  });

  it('skips an EXIF segment to reach the real frame header', () => {
    expect(probeMedia('image/jpeg', jpeg(640, 480, { withExif: true }))).toMatchObject({
      width: 640,
      height: 480,
    });
  });

  it('reads GIF dimensions, which are little-endian', () => {
    expect(probeMedia('image/gif', gif(300, 200))).toMatchObject({ width: 300, height: 200 });
  });

  it('reads lossy WebP dimensions', () => {
    expect(probeMedia('image/webp', webpLossy(1080, 1350))).toMatchObject({
      width: 1080,
      height: 1350,
    });
  });

  it('reads MP4 duration and display dimensions', () => {
    const probe = probeMedia('video/mp4', mp4(30, 1920, 1080));
    expect(probe.durationMs).toBe(30_000);
    expect(probe.width).toBe(1920);
    expect(probe.height).toBe(1080);
    expect(probe.complete).toBe(true);
  });

  it('reports incomplete for a truncated header rather than guessing', () => {
    expect(probeMedia('image/png', png(10, 10).slice(0, 12)).complete).toBe(false);
    expect(probeMedia('image/jpeg', new Uint8Array([0xff, 0xd8])).complete).toBe(false);
  });

  it('survives a malformed box tree without hanging', () => {
    // A box claiming a zero length would loop a naive parser forever.
    const hostile = new Uint8Array(64);
    hostile.set([0x00, 0x00, 0x00, 0x00, 0x6d, 0x6f, 0x6f, 0x76], 0);
    expect(() => probeMedia('video/mp4', hostile)).not.toThrow();
  });

  it('returns incomplete for a type it does not parse', () => {
    expect(probeMedia('application/pdf', new Uint8Array(10)).complete).toBe(false);
  });
});

// ── Keys ────────────────────────────────────────────────────────────────────

describe('object keys', () => {
  const parts = {
    organizationId: '018f0000-0000-7000-8000-00000000000a',
    workspaceId: '018f0000-0000-7000-8000-00000000000b',
    brandId: '018f0000-0000-7000-8000-00000000000c',
    assetId: '018f0000-0000-7000-8000-00000000000d',
    extension: 'jpg',
    now: new Date('2026-08-12T00:00:00Z'),
  };

  it('encodes the tenant in the path, so isolation is visible from the key', () => {
    expect(buildObjectKey(parts)).toBe(
      'org/018f0000-0000-7000-8000-00000000000a/workspace/018f0000-0000-7000-8000-00000000000b/' +
        'brand/018f0000-0000-7000-8000-00000000000c/2026/08/018f0000-0000-7000-8000-00000000000d/original.jpg',
    );
  });

  it('never contains a client-supplied filename', () => {
    const key = buildObjectKey(parts);
    expect(key).not.toContain('..');
    expect(key.split('/').at(-1)).toBe('original.jpg');
  });

  it.each([
    ['path traversal', '../../etc/passwd'],
    ['absolute path', '/etc/passwd'],
    ['not a uuid', 'my-org'],
  ])('rejects %s in an id component', (_label, value) => {
    expect(() => buildObjectKey({ ...parts, organizationId: value })).toThrow(ValidationError);
  });

  it.each(['php', 'jpg/../x', 'j p g', '../', 'exe!'])(
    'rejects unsafe extension %j',
    (extension) => {
      // Only lowercase alphanumerics of a sane length survive.
      if (/^[a-z0-9]{1,8}$/.test(extension)) return;
      expect(() => buildObjectKey({ ...parts, extension })).toThrow(ValidationError);
    },
  );

  it('rejects an unsafe variant name', () => {
    expect(() => buildObjectKey({ ...parts, variant: '../original' })).toThrow(ValidationError);
  });
});

describe('assertKeyBelongsTo', () => {
  const org = '018f0000-0000-7000-8000-00000000000a';
  const other = '018f0000-0000-7000-8000-00000000ffff';

  it('accepts a key under the organization prefix', () => {
    expect(() => assertKeyBelongsTo(`org/${org}/workspace/x/file.jpg`, org)).not.toThrow();
  });

  it('REFUSES to sign a key belonging to another tenant', () => {
    expect(() => assertKeyBelongsTo(`org/${other}/workspace/x/file.jpg`, org)).toThrow(
      /does not belong to this organization/,
    );
  });

  it('is not fooled by a prefix that merely starts the same', () => {
    expect(() => assertKeyBelongsTo(`org/${org}-evil/file.jpg`, org)).toThrow();
  });

  it('marks the refusal as a security event', () => {
    try {
      assertKeyBelongsTo(`org/${other}/f.jpg`, org);
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as ValidationError).context.securityEvent).toBe(true);
    }
  });
});

describe('sanitiseFilename', () => {
  it('strips any path the browser included', () => {
    expect(sanitiseFilename('C:\\Users\\me\\photo.jpg')).toBe('photo.jpg');
    expect(sanitiseFilename('/var/www/photo.jpg')).toBe('photo.jpg');
  });

  it('removes characters that make a filename dangerous', () => {
    expect(sanitiseFilename('../../evil<>:"|?*.jpg')).toBe('evil.jpg');
  });

  it('caps the length', () => {
    expect(sanitiseFilename('a'.repeat(500))?.length).toBe(200);
  });

  it('returns undefined when nothing usable remains', () => {
    expect(sanitiseFilename('///')).toBeUndefined();
    expect(sanitiseFilename(undefined)).toBeUndefined();
  });
});
