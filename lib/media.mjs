// Signed media URLs. The raw Plivo recording URL carries the account credentials' reach into the
// carrier's storage, so it is never handed to the browser: the page can only play audio through a
// short-lived, HMAC-signed link minted here and verified by the stream route.
import crypto from 'node:crypto';
import { env } from '../db/index.mjs';

const secret = () => env.MEDIA_URL_SECRET || 'fallback-media-secret-key-32-bytes-long';

/** The TTL the link stays valid for, in seconds. */
export const ttl = () => Number(env.MEDIA_URL_TTL_SECONDS || 300);

export function signedMediaUrl(recordingId, customTtl) {
  const expires = Math.floor(Date.now() / 1000) + (customTtl || ttl());
  const signature = crypto.createHmac('sha256', secret()).update(`${recordingId}:${expires}`).digest('hex');
  return `/api/recordings/${recordingId}/stream?expires=${expires}&signature=${signature}`;
}

/** Constant-time check of a signed link. */
export function verifySignedMediaRequest(recordingId, expires, signature) {
  if (Math.floor(Date.now() / 1000) > Number(expires)) return false;
  const expected = crypto.createHmac('sha256', secret()).update(`${recordingId}:${expires}`).digest('hex');
  const a = Buffer.from(String(signature || ''), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
