// Plivo's V3 webhook signature, computed exactly the way the Plivo SDK does it, so a webhook that
// Plivo signed verifies here without pulling the SDK in.
import crypto from 'node:crypto';

/**
 * @param {'GET'|'POST'} method
 * @param {string} uri       the absolute URL Plivo called (public base + path + query)
 * @param {string} nonce     X-Plivo-Signature-V3-Nonce
 * @param {string} authToken the Plivo auth token
 * @param {object} params    the parsed body parameters
 */
export function computeV3Signature(method, uri, nonce, authToken, params = {}) {
  const url = new URL(uri);
  let base = `${url.protocol}//${url.host}${url.pathname}`;

  const query = {};
  url.searchParams.forEach((v, k) => {
    (query[k] = query[k] || []).push(v);
  });

  const sortedQuery = [];
  Object.keys(query).sort().forEach(k => query[k].sort().forEach(v => sortedQuery.push(`${k}=${v}`)));

  if (method === 'GET') {
    for (const k of Object.keys(params).sort()) {
      const v = params[k];
      (Array.isArray(v) ? v : [v]).forEach(x => sortedQuery.push(`${k}=${x}`));
    }
    if (sortedQuery.length) base += `?${sortedQuery.join('&')}`;
  } else {
    const hasPost = Object.keys(params).length > 0;
    if (sortedQuery.length || hasPost) base += `?${sortedQuery.join('&')}`;
    if (sortedQuery.length && hasPost) base += '.';
    const sortedPost = [];
    Object.keys(params).sort().forEach(k => {
      const v = params[k];
      (Array.isArray(v) ? v : [v]).forEach(x => sortedPost.push(`${k}${x}`));
    });
    base += sortedPost.join('');
  }

  return crypto.createHmac('sha256', authToken).update(`${base}.${nonce}`).digest('base64');
}

/** True when any of the comma-separated signatures Plivo sent is ours. */
export function verifyV3Signature({ method, url, nonce, authToken, signature, params }) {
  if (!nonce || !signature || !authToken) return false;
  const expected = computeV3Signature(method, url, nonce, authToken, params);
  const sent = String(signature).split(',').map(s => s.trim()).filter(Boolean);
  return sent.some(sig => {
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}
