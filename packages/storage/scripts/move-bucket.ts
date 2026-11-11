/**
 * Move media from the AWS bucket to the Railway bucket (D-118), and prove the
 * new bucket works with this app's exact client settings before switching.
 *
 *   pnpm --filter @orbit/storage build
 *   node --experimental-strip-types packages/storage/scripts/move-bucket.ts <command>
 *
 * Commands:
 *   check    Exercise the TARGET bucket the way the app does: a presigned PUT
 *            sent the way a browser sends it, HEAD, a ranged GET (media
 *            verification), a presigned GET (what Meta and Threads fetch), a
 *            server-side PUT (reports), a batch delete (retention). Then print
 *            its CORS origins. Writes and deletes only under `_bucket-check/`.
 *   cors     Set the TARGET bucket's CORS so browsers on CORS_ORIGINS
 *            (comma-separated origins) may upload to it.
 *   copy     Copy every object from SOURCE to TARGET under the same key. An
 *            object already in TARGET with the same size is skipped, so it is
 *            safe to run again after the switch to pick up late uploads.
 *   compare  Count objects and bytes on both sides and list keys missing from
 *            TARGET.
 *
 * Connection settings come from the environment only, never from `.env`, so
 * the script cannot be pointed at a bucket by accident. For each of SOURCE and
 * TARGET:
 *
 *   <SIDE>_S3_BUCKET, <SIDE>_S3_REGION, <SIDE>_S3_ACCESS_KEY_ID,
 *   <SIDE>_S3_SECRET_ACCESS_KEY, and optionally <SIDE>_S3_ENDPOINT and
 *   <SIDE>_S3_FORCE_PATH_STYLE=true
 *
 * Secrets are never printed. Object keys are printed only when something
 * failed or is missing.
 */
import {
  DeleteObjectsCommand,
  GetBucketCorsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3ClientConfig } from '../dist/client-config.js';

const CHECK_PREFIX = '_bucket-check/';
const COPY_CONCURRENCY = 4;

function connect(side) {
  const read = (name) => process.env[`${side}_S3_${name}`]?.trim() || undefined;
  const required = ['BUCKET', 'REGION', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY'];
  const missing = required.filter((name) => !read(name)).map((name) => `${side}_S3_${name}`);
  if (missing.length > 0) {
    console.error(`Set ${missing.join(', ')}.`);
    process.exit(1);
  }

  const endpoint = read('ENDPOINT');
  const forcePathStyle = ['true', '1'].includes((read('FORCE_PATH_STYLE') ?? '').toLowerCase());
  const bucket = read('BUCKET');

  return {
    bucket,
    label: `${side.toLowerCase()} bucket ${bucket} (${endpoint ? new URL(endpoint).host : 'AWS'})`,
    client: new S3Client(
      s3ClientConfig({
        region: read('REGION'),
        accessKeyId: read('ACCESS_KEY_ID'),
        secretAccessKey: read('SECRET_ACCESS_KEY'),
        endpoint,
        forcePathStyle,
      }),
    ),
  };
}

function describeError(error) {
  const name = error?.name ?? 'Error';
  const status = error?.$metadata?.httpStatusCode;
  return status ? `${name} (HTTP ${status})` : `${name}: ${error?.message ?? ''}`;
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

async function* listAll(side) {
  let token;
  do {
    const page = await side.client.send(
      new ListObjectsV2Command({ Bucket: side.bucket, ContinuationToken: token }),
    );
    for (const object of page.Contents ?? []) {
      if (object.Key && !object.Key.startsWith(CHECK_PREFIX)) yield object;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
}

async function sizeIn(side, key) {
  try {
    const head = await side.client.send(new HeadObjectCommand({ Bucket: side.bucket, Key: key }));
    return head.ContentLength ?? 0;
  } catch (error) {
    if (error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}

// ── check ────────────────────────────────────────────────────────────────────

async function check() {
  const target = connect('TARGET');
  console.log(`Checking ${target.label}`);

  const stamp = Date.now();
  const uploadKey = `${CHECK_PREFIX}${stamp}-upload.txt`;
  const serverKey = `${CHECK_PREFIX}${stamp}-server.txt`;
  const text = 'Social Square bucket check';
  const body = new TextEncoder().encode(text);
  let failed = false;

  async function step(name, run) {
    try {
      const detail = await run();
      console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
      return true;
    } catch (error) {
      failed = true;
      console.log(`  ✗ ${name} — ${describeError(error)}`);
      return false;
    }
  }

  await step('bucket reachable', () =>
    target.client.send(new HeadBucketCommand({ Bucket: target.bucket })),
  );

  // Signed exactly as `presignUpload` signs it: type and length are part of
  // the signature. Sent the way a browser sends it.
  const uploaded = await step('presigned PUT, as a browser upload', async () => {
    const url = await getSignedUrl(
      target.client,
      new PutObjectCommand({
        Bucket: target.bucket,
        Key: uploadKey,
        ContentType: 'text/plain',
        ContentLength: body.byteLength,
      }),
      { expiresIn: 300 },
    );
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body,
    });
    if (!response.ok) {
      throw new Error(`PUT answered ${response.status} ${await response.text()}`);
    }
  });

  if (uploaded) {
    await step('HEAD reports the size', async () => {
      const size = await sizeIn(target, uploadKey);
      if (size !== body.byteLength) throw new Error(`size ${size}, expected ${body.byteLength}`);
    });

    await step('ranged GET, as media verification reads', async () => {
      const result = await target.client.send(
        new GetObjectCommand({ Bucket: target.bucket, Key: uploadKey, Range: 'bytes=0-5' }),
      );
      const read = new TextDecoder().decode(await result.Body.transformToByteArray());
      if (read !== text.slice(0, 6)) throw new Error(`read "${read}"`);
    });

    await step('presigned GET, as a platform fetches media', async () => {
      const url = await getSignedUrl(
        target.client,
        new GetObjectCommand({ Bucket: target.bucket, Key: uploadKey }),
        { expiresIn: 300 },
      );
      const response = await fetch(url);
      const read = await response.text();
      if (!response.ok || read !== text) throw new Error(`GET answered ${response.status}`);
    });
  }

  await step('server-side PUT, as a report is written', () =>
    target.client.send(
      new PutObjectCommand({
        Bucket: target.bucket,
        Key: serverKey,
        Body: body,
        ContentType: 'text/plain',
      }),
    ),
  );

  await step('batch delete, as retention deletes', async () => {
    const result = await target.client.send(
      new DeleteObjectsCommand({
        Bucket: target.bucket,
        Delete: { Objects: [{ Key: uploadKey }, { Key: serverKey }], Quiet: true },
      }),
    );
    if (result.Errors?.length) throw new Error(`${result.Errors.length} key(s) not deleted`);
    if ((await sizeIn(target, serverKey)) !== null) throw new Error('object still there');
  });

  await step('CORS', async () => {
    try {
      const cors = await target.client.send(new GetBucketCorsCommand({ Bucket: target.bucket }));
      const origins = (cors.CORSRules ?? []).flatMap((rule) => rule.AllowedOrigins ?? []);
      return origins.length > 0 ? `allows ${origins.join(', ')}` : 'no origins allowed';
    } catch (error) {
      if (error?.name === 'NoSuchCORSConfiguration') {
        return 'not set yet — run the cors command';
      }
      throw error;
    }
  });

  console.log(failed ? '\nSome checks failed. Do not switch yet.' : '\nAll checks passed.');
  process.exit(failed ? 1 : 0);
}

// ── cors ─────────────────────────────────────────────────────────────────────

async function cors() {
  const target = connect('TARGET');
  const origins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    console.error('Set CORS_ORIGINS, e.g. https://www.socialsquare.site');
    process.exit(1);
  }
  for (const origin of origins) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      parsed = undefined;
    }
    if (!parsed || parsed.origin !== origin) {
      console.error(`"${origin}" is not an origin. Write it as https://host, with no path.`);
      process.exit(1);
    }
  }

  await target.client.send(
    new PutBucketCorsCommand({
      Bucket: target.bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: origins,
            AllowedMethods: ['GET', 'HEAD', 'PUT'],
            AllowedHeaders: ['*'],
            ExposeHeaders: ['ETag'],
            MaxAgeSeconds: 3000,
          },
        ],
      },
    }),
  );
  console.log(`CORS on ${target.label} now allows ${origins.join(', ')}.`);
}

// ── copy ─────────────────────────────────────────────────────────────────────

async function copy() {
  const source = connect('SOURCE');
  const target = connect('TARGET');
  console.log(`Copying from ${source.label}\n          to ${target.label}`);

  let copied = 0;
  let skipped = 0;
  let failed = 0;
  let bytes = 0;

  async function copyOne(object) {
    const key = object.Key;
    const size = object.Size ?? 0;
    try {
      if ((await sizeIn(target, key)) === size) {
        skipped += 1;
        return;
      }
      const got = await source.client.send(
        new GetObjectCommand({ Bucket: source.bucket, Key: key }),
      );
      await target.client.send(
        new PutObjectCommand({
          Bucket: target.bucket,
          Key: key,
          Body: got.Body,
          ContentLength: size,
          ContentType: got.ContentType,
          ContentDisposition: got.ContentDisposition,
          CacheControl: got.CacheControl,
          Metadata: got.Metadata,
        }),
      );
      copied += 1;
      bytes += size;
    } catch (error) {
      failed += 1;
      console.log(`  ✗ ${key} — ${describeError(error)}`);
    }
    const done = copied + skipped + failed;
    if (done % 100 === 0) {
      console.log(`  … ${done} objects (${copied} copied, ${formatBytes(bytes)})`);
    }
  }

  const running = new Set();
  for await (const object of listAll(source)) {
    const task = copyOne(object).finally(() => running.delete(task));
    running.add(task);
    if (running.size >= COPY_CONCURRENCY) await Promise.race(running);
  }
  await Promise.all(running);

  console.log(
    `\nCopied ${copied} (${formatBytes(bytes)}), already there ${skipped}, failed ${failed}.`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

// ── compare ──────────────────────────────────────────────────────────────────

async function compare() {
  const source = connect('SOURCE');
  const target = connect('TARGET');

  const inTarget = new Map();
  let targetBytes = 0;
  for await (const object of listAll(target)) {
    inTarget.set(object.Key, object.Size ?? 0);
    targetBytes += object.Size ?? 0;
  }

  let sourceCount = 0;
  let sourceBytes = 0;
  const missing = [];
  for await (const object of listAll(source)) {
    sourceCount += 1;
    sourceBytes += object.Size ?? 0;
    if (inTarget.get(object.Key) !== (object.Size ?? 0)) missing.push(object.Key);
  }

  console.log(`${source.label}: ${sourceCount} objects, ${formatBytes(sourceBytes)}`);
  console.log(`${target.label}: ${inTarget.size} objects, ${formatBytes(targetBytes)}`);

  if (missing.length === 0) {
    console.log('\nEvery source object is in the target with the same size.');
    process.exit(0);
  }
  console.log(`\n${missing.length} missing or a different size in the target, for example:`);
  for (const key of missing.slice(0, 20)) console.log(`  ${key}`);
  console.log('Run copy again.');
  process.exit(1);
}

const commands = { check, cors, copy, compare };
const command = commands[process.argv[2]];
if (!command) {
  console.error('Usage: move-bucket.ts check | cors | copy | compare');
  process.exit(1);
}
await command();
