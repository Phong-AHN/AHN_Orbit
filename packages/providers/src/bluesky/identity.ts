import { toAppError } from '../errors.js';
import type { BlueskyHttp } from './client.js';

/**
 * Who an account really is, and which server really speaks for it.
 *
 * A token response names an account by DID (`sub`). Trusting that alone would
 * let any authorization server claim any account, so atproto requires the
 * client to walk the chain itself: DID → DID document → the account's PDS →
 * the PDS's declared authorization server — and that server must be the one
 * that issued the token. Skipping it is the hole the spec warns about.
 */

interface DidDocument {
  id?: string;
  alsoKnownAs?: string[];
  service?: Array<{ id?: string; type?: string; serviceEndpoint?: string }>;
}

export interface ResolvedIdentity {
  did: string;
  pds: string;
  handle?: string | undefined;
}

export async function resolveIdentity(
  http: BlueskyHttp,
  did: string,
  plcDirectory: string,
): Promise<ResolvedIdentity> {
  const document = await didDocument(http, did, plcDirectory);

  if (document.id !== did) {
    throw refusal(`DID document for ${did} names ${document.id ?? 'nobody'}`);
  }

  const pds = document.service?.find(
    (service) =>
      (service.id === '#atproto_pds' || service.id === `${did}#atproto_pds`) &&
      service.type === 'AtprotoPersonalDataServer',
  )?.serviceEndpoint;

  if (!pds || !/^https:\/\//.test(pds)) throw refusal(`${did} declares no HTTPS PDS`);

  const handle = document.alsoKnownAs
    ?.find((alias) => alias.startsWith('at://'))
    ?.slice('at://'.length);

  return { did, pds: pds.replace(/\/$/, ''), ...(handle ? { handle } : {}) };
}

/** The authorization server a PDS says it trusts. */
export async function authorizationServerFor(http: BlueskyHttp, pds: string): Promise<string> {
  const metadata = await http.getJson<{ authorization_servers?: string[] }>(
    `${pds}/.well-known/oauth-protected-resource`,
  );
  const server = metadata.authorization_servers?.[0];
  if (!server) throw refusal(`${pds} names no authorization server`);
  return server.replace(/\/$/, '');
}

async function didDocument(
  http: BlueskyHttp,
  did: string,
  plcDirectory: string,
): Promise<DidDocument> {
  if (did.startsWith('did:plc:')) {
    return http.getJson<DidDocument>(`${plcDirectory}/${encodeURIComponent(did)}`);
  }
  if (did.startsWith('did:web:')) {
    const host = decodeURIComponent(did.slice('did:web:'.length));
    // atproto allows did:web only at a hostname, never a path.
    if (host.includes(':') || host.includes('/')) throw refusal(`Unsupported did:web ${did}`);
    return http.getJson<DidDocument>(`https://${host}/.well-known/did.json`);
  }
  throw refusal(`Unsupported DID method in ${did}`);
}

function refusal(message: string) {
  return toAppError('BLUESKY', {
    kind: 'AUTHENTICATION',
    message,
    userMessage: 'Bluesky could not confirm which account signed in. Please try connecting again.',
  });
}
