// Generate the ES256 key Social Square signs its Bluesky client assertions
// with (D-112), as the one-line JWK that BLUESKY_PRIVATE_KEY expects.
//
//   node apps/web/scripts/generate-bluesky-key.mjs
//
// Put the output in BLUESKY_PRIVATE_KEY on the web app *and* the worker, and
// nowhere else. Keep it: a new key disconnects every Bluesky account, because
// their sessions are bound to the client that started them.

import { generateKeyPairSync, randomUUID } from 'node:crypto';
import process from 'node:process';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = privateKey.export({ format: 'jwk' });

process.stdout.write(
  `${JSON.stringify({ kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x, y: jwk.y, kid: `social-square-${randomUUID().slice(0, 8)}` })}\n`,
);
