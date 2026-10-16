// lib/plivo.mjs — the call desk's own Plivo client, so this app can make and take calls itself.
// Deliberately dependency-free: Plivo's REST API is JSON over HTTP Basic auth, so fetch is enough.
//
//   place a call     POST /v1/Account/{auth_id}/Call/          {from, to, answer_url, ring_url, ...}
//   answer the leg   our answer_url must reply with Plivo XML  (see lib/plivo-xml.mjs)
//   record it        POST /v1/Account/{auth_id}/Call/{uuid}/Record/   {file_format:'mp3'}
//   collect audio    GET  /v1/Account/{auth_id}/Recording/     (then OpenAI whisper transcribes it)
//   account sanity   GET  /v1/Account/{auth_id}/
//
// Credentials come from the app's own .env, never from the client bundle.
//
//   node lib/plivo.mjs account
//   node lib/plivo.mjs numbers | recordings | calls
import { env } from '../db/index.mjs';

const AUTH_ID = env.PLIVO_AUTH_ID || '';
const AUTH_TOKEN = env.PLIVO_AUTH_TOKEN || '';
const CALLER_ID = env.PLIVO_CALLER_ID || '';
const REGION_HOST = env.PLIVO_API_HOST || 'api.plivo.com';
const authHeader = () => 'Basic ' + Buffer.from(`${AUTH_ID}:${AUTH_TOKEN}`).toString('base64');

export const configured = () => !!(AUTH_ID && AUTH_TOKEN);
export const callerId = () => CALLER_ID;
export const sipEndpoint = () => env.PLIVO_SIP_ENDPOINT || null;
export const endpointPassword = () => env.PLIVO_ENDPOINT_PASSWORD || null;

/**
 * The SIP endpoint this account ACTUALLY has. The .env value can be stale — ours named an endpoint
 * that does not exist on the account at all, which surfaces as a bare "Authentication Error" in the
 * browser. Ask Plivo, and only fall back to .env if the API has nothing.
 */
let endpointCache = null;
export async function latestEndpoint() {
  if (endpointCache) return endpointCache;
  const password = env.PLIVO_ENDPOINT_PASSWORD || null;
  try {
    const j = await plivo('/Endpoint/');
    const e = (j?.objects || [])[0];
    if (e?.username) {
      endpointCache = {
        username: e.username,
        sipUri: e.sip_uri || `sip:${e.username}@phone.plivo.com`,
        alias: e.alias || null,
        id: e.endpoint_id || null,
        appId: e.app_id || null,
        password,
        source: 'plivo',
      };
      return endpointCache;
    }
  } catch { /* fall through to the env value */ }
  const u = String(env.PLIVO_SIP_ENDPOINT || '').replace(/^sip:/, '').split('@')[0];
  endpointCache = u ? { username: u, sipUri: `sip:${u}@phone.plivo.com`, alias: null, id: null, appId: null, password, source: 'env' } : null;
  return endpointCache;
}

async function plivo(pathname, { method = 'GET', body, form } = {}) {
  if (!configured()) throw new Error('Plivo is not configured (no PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN)');
  const headers = { authorization: authHeader() };
  let payload;
  if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
  else if (body) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`https://${REGION_HOST}/v1/Account/${AUTH_ID}${pathname}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* XML or empty */ }
  if (!res.ok) {
    const err = new Error(`Plivo ${method} ${pathname} -> HTTP ${res.status}: ${(json?.error || text).slice(0, 200)}`);
    err.status = res.status; err.json = json;
    throw err;
  }
  return json;
}

/** Account sanity: proves the credentials work at all. */
export const account = () => plivo('/');

/** Numbers this account owns. */
export const numbers = () => plivo('/Number/').then(j => j?.objects || []);

/** Recordings Plivo holds (optionally for one call). */
export const recordings = (callUuid) => plivo(`/Recording/${callUuid ? `?call_uuid=${encodeURIComponent(callUuid)}` : ''}`).then(j => j?.objects || []);

/** Call detail records. */
export const calls = (limit = 20) => plivo(`/Call/?limit=${limit}`).then(j => j?.objects || []);

/** One call's live detail (status, duration, cost, hangup cause). */
export const call = (uuid) => plivo(`/Call/${uuid}/`);

/**
 * Place a call. Plivo will fetch `answerUrl` the moment the call is answered, and the XML we return
 * there decides everything that follows (greeting, bridging, recording).
 */
export async function placeCall({ to, from = CALLER_ID, answerUrl, ringUrl, hangupUrl, machineDetection, timeLimit = 3600 }) {
  if (!to) throw new Error('placeCall needs a destination number');
  if (!answerUrl) throw new Error('placeCall needs an answerUrl (Plivo fetches it to control the call)');
  const form = { from, to, answer_url: answerUrl, answer_method: 'POST', time_limit: String(timeLimit) };
  if (ringUrl) { form.ring_url = ringUrl; form.ring_method = 'POST'; }
  if (hangupUrl) { form.hangup_url = hangupUrl; form.hangup_method = 'POST'; }
  if (machineDetection) { form.machine_detection = 'true'; }
  const j = await plivo('/Call/', { method: 'POST', form });
  return { requestUuid: j?.request_uuid || j?.requestUuid || null, apiId: j?.api_id || null, message: j?.message || 'Call initiated' };
}

export const hangup = (uuid) => plivo(`/Call/${uuid}/`, { method: 'DELETE' });

export const startRecording = (uuid, { format = 'mp3', timeLimit } = {}) => {
  const form = { file_format: format };
  if (timeLimit) form.time_limit = String(timeLimit);
  return plivo(`/Call/${uuid}/Record/`, { method: 'POST', form });
};

export const stopRecording = (uuid) => plivo(`/Call/${uuid}/Record/`, { method: 'DELETE' });

export const sendDigits = (uuid, digits) => plivo(`/Call/${uuid}/DTMF/`, { method: 'POST', form: { digits } });

export const speak = (uuid, text, { language = 'en-IN', voice = 'Polly.Aditi' } = {}) =>
  plivo(`/Call/${uuid}/Speak/`, { method: 'POST', form: { text, language, voice } });

export const playAudio = (uuid, urls) => plivo(`/Call/${uuid}/Play/`, { method: 'POST', form: { urls: [].concat(urls).join(',') } });

/** Where Plivo must reach us for this call. Must be public: set PUBLIC_URL when a tunnel is up. */
export function webhookBase() {
  const base = env.PUBLIC_URL || process.env.PUBLIC_URL || env.PUBLIC_BASE_URL || '';
  return base.replace(/\/+$/, '');
}

/**
 * Sanity-check that the public URL actually reaches THIS app before we hand it to Plivo. A tunnel
 * pointing at the wrong local port is the classic silent failure: Plivo calls a URL that answers 401
 * (some other app), the call connects with no XML, and nothing is ever recorded.
 */
export async function checkReachable(base = webhookBase()) {
  if (!base) return { ok: false, reason: 'no public url configured (set PUBLIC_URL when your tunnel is up)' };
  try {
    const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(6000) });
    const j = await r.json().catch(() => null);
    const ours = !!(j && (j.service === 'travel-office' || j.app === 'travel-office' || j.office
      || (j.ok === true && /3dots\s*Travel/i.test(String(j.brand || j.name || '')))));
    return { ok: r.ok && ours, status: r.status, body: j, reason: r.ok && ours ? 'reaches the travel office' : 'a different app answered — check which port the tunnel points at' };
  } catch (e) {
    return { ok: false, reason: `unreachable: ${e.message}` };
  }
}

/* ---------- number inventory: search, buy, release ---------- */

/** Available numbers for a country (Plivo requires country_iso). */
export const searchNumbers = ({ countryIso = 'US', type = 'local', region, city, pattern, limit = 20 } = {}) => {
  const q = new URLSearchParams({ country_iso: countryIso, type, limit: String(limit) });
  if (region) q.set('region', region);
  if (city) q.set('city', city);
  if (pattern) q.set('pattern', pattern);
  if (type === 'tollfree') q.delete('region');
  return plivo(`/PhoneNumber/?${q}`).then(j => j?.objects || []);
};

/** Buy (rent) a number and point it at our answer URL. */
export async function buyNumber(number, { appId, alias } = {}) {
  if (!number) throw new Error('buyNumber needs a number');
  const form = { number };
  if (appId) form.app_id = appId;
  if (alias) form.alias = alias;
  return plivo('/Number/', { method: 'POST', form });
}

/** Release a number we own. */
export const releaseNumber = number => plivo(`/Number/${encodeURIComponent(number)}/`, { method: 'DELETE' });

/** Point an owned number at an application. */
export const attachApplication = (number, appId) =>
  plivo(`/Number/${encodeURIComponent(number)}/`, { method: 'POST', form: { app_id: appId } });

/* ---------- applications: the answer URL a number answers with ---------- */

export const applications = () => plivo('/Application/').then(j => j?.objects || []);

export function createApplication({ name, answerUrl, answerMethod = 'POST', hangupUrl }) {
  const form = { app_name: name, answer_url: answerUrl, answer_method: answerMethod };
  if (hangupUrl) { form.hangup_url = hangupUrl; form.hangup_method = 'POST'; }
  return plivo('/Application/', { method: 'POST', form });
}

export function updateApplication(appId, { name, answerUrl, answerMethod = 'POST', hangupUrl }) {
  const form = { answer_url: answerUrl, answer_method: answerMethod };
  if (name) form.app_name = name;
  if (hangupUrl) { form.hangup_url = hangupUrl; form.hangup_method = 'POST'; }
  return plivo(`/Application/${appId}/`, { method: 'POST', form });
}

/* ---------- recordings ---------- */

export const deleteRecording = recordingId => plivo(`/Recording/${recordingId}/`, { method: 'DELETE' });

/* ---------- endpoints (the browser softphone registers with these) ---------- */

export const endpoints = () => plivo('/Endpoint/').then(j => j?.objects || []);

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────
const invokedAsScript = !!process.argv[1] && /plivo\.mjs$/.test(process.argv[1]);
if (invokedAsScript) {
  const cmd = process.argv[2] || 'account';
  try {
    if (!configured()) { console.error('✗ no Plivo credentials found in the office .env'); process.exit(1); }
    if (cmd === 'account') {
      const a = await account();
      console.log('account     :', a.name || a.auth_id);
      console.log('auth id     :', a.auth_id);
      console.log('credits     :', a.cash_credits, a.currency);
      console.log('caller id   :', CALLER_ID || '(none set)');
      console.log('sip endpoint:', sipEndpoint() ? 'configured' : '—');
    } else if (cmd === 'numbers') {
      for (const n of await numbers()) console.log(` ${n.number}  ${n.alias || '-'}  app=${n.app_id || '-'}  voice=${n.voice_rate || '-'}`);
    } else if (cmd === 'recordings') {
      const r = await recordings(process.argv[3]);
      console.log(r.length, 'recording(s)');
      for (const x of r.slice(0, 8)) console.log(` ${String(x.recording_id).slice(0, 8)} ${Math.round((x.recording_duration_ms || 0) / 1000)}s ${x.call_uuid?.slice(0, 8)} ${x.recording_format || ''}`);
    } else if (cmd === 'calls') {
      for (const c of await calls(10)) console.log(` ${String(c.call_uuid).slice(0, 8)} ${c.call_direction} ${c.from_number} -> ${c.to_number} ${c.call_state} ${c.call_duration}s`);
    } else if (cmd === 'reachable') {
      console.log(JSON.stringify(await checkReachable(), null, 1));
    } else {
      console.log('usage: node lib/plivo.mjs account|numbers|recordings [uuid]|calls|reachable');
    }
  } catch (e) {
    console.error('✗', e.message);
    process.exit(1);
  }
}
