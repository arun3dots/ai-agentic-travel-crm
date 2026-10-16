// The desk phone — the Plivo SIP line this page registers so a person can talk to the guest from the
// browser, plus the status strip the phone widget shows.
import express from 'express';
import { db, orgId, newId } from '../db/index.mjs';
import { wrap, fail, text, phoneNumber } from './http.mjs';
import * as plivo from '../lib/plivo.mjs';
import { logAudit } from '../lib/audit.mjs';

export const plivoRouter = () => {
  const r = express.Router();

  r.get('/endpoint', wrap(async (_req, res) => {
    const endpoint = await plivo.latestEndpoint();
    if (!endpoint?.username) return res.status(409).json({ error: 'this Plivo account has no SIP endpoint — the browser phone cannot register' });
    res.json({ username: endpoint.username, password: endpoint.password, sipUri: endpoint.sipUri, source: endpoint.source });
  }));

  r.get('/status', wrap(async (_req, res) => {
    let account = null, error = null;
    if (plivo.configured()) {
      account = await plivo.account().catch(e => { error = e.message; return null; });
    }
    const endpoint = await plivo.latestEndpoint().catch(() => null);
    const reach = await plivo.checkReachable().catch(e => ({ ok: false, reason: e.message }));
    res.json({
      configured: plivo.configured(),
      username: endpoint?.username || null,
      callerId: plivo.callerId() || null,
      account: account ? { name: account.name, authId: account.auth_id, credits: account.cash_credits, currency: account.currency || 'USD' } : null,
      webhook: { base: plivo.webhookBase() || null, ok: !!reach.ok, reason: reach.reason, answerUrl: `${plivo.webhookBase() || ''}/api/webhooks/plivo/answer` },
      error,
    });
  }));

  /** The phone widget dials through here: `mode: 'browser'` bridges the guest to this page. */
  r.post('/call', wrap(async (req, res) => {
    const organizationId = await orgId();
    const body = req.body || {};
    const to = phoneNumber(body.to, { required: true, field: 'number' });
    if (!plivo.configured()) throw fail(400, 'Plivo is not configured — add the credentials to .env first');

    const base = plivo.webhookBase();
    const reach = await plivo.checkReachable(base);
    if (!reach.ok) throw fail(400, `Plivo cannot reach this office at ${base || '(no public URL set)'} — ${reach.reason}`);

    const from = plivo.callerId();
    if (!from) throw fail(400, 'no caller id configured — set PLIVO_CALLER_ID');

    const mode = body.mode === 'browser' ? 'browser' : 'message';
    const placed = await plivo.placeCall({
      to, from,
      answerUrl: `${base}/api/webhooks/plivo/answer?mode=${mode}`,
      ringUrl: `${base}/api/webhooks/plivo/ring`,
      hangupUrl: `${base}/api/webhooks/plivo/hangup`,
    });

    const call = await db.one(`
      INSERT INTO calls (id,"organizationId","plivoCallUuid","requestUuid",direction,status,"from","to","startedAt",
                         "recordingEnabled","transcriptionEnabled","requestedMode","requestedParams","updatedAt")
      VALUES ($1,$2,$3,$4,'outbound','queued',$5,$6, now(), true, true, $7, $8, now()) RETURNING *`,
      [newId(), organizationId, `request_${placed.requestUuid || Date.now()}`, placed.requestUuid, from, to, mode,
       JSON.stringify({ source: 'desk phone', requestedBy: text(body.by, { max: 120 }) || 'Holiday desk' })]);

    await logAudit({ action: 'call.place', targetType: 'Call', targetId: call.id, metadata: { to, from, mode, source: 'desk phone' } });
    res.status(201).json({ ...placed, callId: call.id });
  }));

  return r;
};
