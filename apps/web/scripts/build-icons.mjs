/**
 * Rasterise the Social Square icon (app/icon.svg) into every size the site and
 * the platform portals need, from the one source, so they cannot drift apart:
 * TikTok, Meta and Google all check that the app icon they were given matches
 * the website's favicon.
 *
 *   node apps/web/scripts/build-icons.mjs
 *
 * Writes app/apple-icon.png (180), app/favicon.ico (16/32/48, PNG-in-ICO) and
 * public/brand/social-square-icon-{512,1024}.png for portal uploads.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import sharp from 'sharp';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(web, 'app', 'icon.svg'));

const png = (size) => sharp(svg, { density: 384 }).resize(size, size).png().toBuffer();

/** An ICO whose entries are PNGs — valid since Windows Vista, and in every browser. */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

const brand = join(web, 'public', 'brand');
mkdirSync(brand, { recursive: true });

writeFileSync(join(web, 'app', 'apple-icon.png'), await png(180));
writeFileSync(
  join(web, 'app', 'favicon.ico'),
  ico(await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await png(size) })))),
);
for (const size of [512, 1024]) {
  writeFileSync(join(brand, `social-square-icon-${size}.png`), await png(size));
}
process.stdout.write('icons written\n');
