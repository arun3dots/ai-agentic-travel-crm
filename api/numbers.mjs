// Numbers desk — the lines the office answers on.
//
// Plivo owns the inventory; this desk mirrors what the office holds and can search, buy, point at the
// answer URL, and release. Buying costs real money, so the route says exactly which number it bought.
import express from 'express';
import { db, orgId, newId } from '../db/index.mjs';
import { wrap, fail, requireId, text, bool } from './http.mjs';
import { logAudit } from '../lib/audit.mjs';
import * as plivo from '../lib/plivo.mjs';

export const numbersRouter = () => {
  const r = express.Router();

  r.get('/', wrap(async (_req, res) => {
    const organizationId = await orgId();
    const numbers = await db.many(`
      SELECT n.*,
             (SELECT count(*)::int FROM calls c WHERE c."phoneNumberId" = n.id) AS "callCount",
             (SELECT count(*)::int FROM messages m WHERE m."phoneNumberId" = n.id) AS "messageCount"
      FROM phone_numbers n
      WHERE n."organizationId" = $1
      ORDER BY n.status, n."e164"`, [organizationId]);
    const callerId = plivo.callerId();
    res.json({
      numbers,
      callerId,
      configured: plivo.configured(),
      webhook: { base: plivo.webhookBase() || null, answerUrl: `${plivo.webhookBase() || ''}/api/webhooks/plivo/answer` },
    });
  }));

  /** Live inventory at the carrier. */
  r.get('/search', wrap(async (req, res) => {
    if (!plivo.configured()) throw fail(400, 'Plivo is not configured — add the credentials to .env first');
    const available = await plivo.searchNumbers({
      countryIso: String(req.query.countryIso || 'US').toUpperCase(),
      type: String(req.query.type || 'local'),
      region: req.query.region ? String(req.query.region) : undefined,
      city: req.query.city ? String(req.query.city) : undefined,
      pattern: req.query.pattern ? String(req.query.pattern) : undefined,
      limit: Math.min(50, Number(req.query.limit) || 20),
    });
    res.json({
      available: available.map(n => ({
        number: n.number, country: n.country, region: n.region, city: n.city,
        type: n.type || n.number_type, setupRate: n.setup_rate, monthlyRental: n.rental_rate,
        voiceRate: n.voice_rate, smsRate: n.sms_rate, mmsRate: n.mms_rate, currency: n.currency || n.rental_rate_currency,
      })),
    });
  }));

  /** Rent a number and point it at this office's answer URL. */
  r.post('/buy', wrap(async (req, res) => {
    const organizationId = await orgId();
    const body = req.body || {};
    const number = text(body.number, { required: true, field: 'number', max: 20 });
    if (!plivo.configured()) throw fail(400, 'Plivo is not configured — add the credentials to .env first');

    const account = await db.one('SELECT id FROM plivo_accounts WHERE "organizationId" = $1 ORDER BY "createdAt" LIMIT 1', [organizationId]);
    if (!account) throw fail(400, 'no Plivo account is on file for this office');

    const base = plivo.webhookBase();
    const apps = await plivo.applications().catch(() => []);
    let appId = apps.find(a => (a.answer_url || '').includes('/api/webhooks/plivo/answer'))?.app_id;
    if (!appId && base) {
      const created = await plivo.createApplication({
        name: '3dots Travel — holiday desk',
        answerUrl: `${base}/api/webhooks/plivo/answer`,
        hangupUrl: `${base}/api/webhooks/plivo/hangup`,
      });
      appId = created?.app_id;
    }

    const bought = await plivo.buyNumber(number, { appId, alias: text(body.alias, { max: 60 }) || 'holiday desk' });
    const row = await db.one(`
      INSERT INTO phone_numbers (id,"organizationId","plivoAccountId","applicationId","e164","countryIso","numberType",region,city,"friendlyName","recordCalls","transcribeEnabled","status",source,"purchasedAt","rawPayload","updatedAt")
      VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,true,true,'active','purchased', now(), $10, now())
      ON CONFLICT ("organizationId","e164") DO UPDATE SET status='active', "releasedAt"=NULL, "updatedAt"=now()
      RETURNING *`,
      [newId(), organizationId, account.id, number, String(body.countryIso || '').toUpperCase() || number.slice(1, 3),
       text(body.type, { max: 20 }) || 'local', text(body.region, { max: 80 }), text(body.city, { max: 80 }),
       text(body.alias, { max: 80 }), JSON.stringify(bought)]);

    await logAudit({ action: 'number.buy', targetType: 'PhoneNumber', targetId: row.id, metadata: { number, appId } });
    res.status(201).json({ number: row, bought });
  }));

  /** Point an owned number at the office's answer URL (or any URL). */
  r.post('/:id/bind', wrap(async (req, res) => {
    const organizationId = await orgId();
    const row = await db.one('SELECT * FROM phone_numbers WHERE id = $1 AND "organizationId" = $2', [requireId(req.params.id, 'number id'), organizationId]);
    if (!row) throw fail(404, 'no such number');
    const answerUrl = text((req.body || {}).answerUrl, { max: 500 }) || `${plivo.webhookBase()}/api/webhooks/plivo/answer`;
    const app = await plivo.createApplication({ name: `3dots Travel — ${row.e164}`, answerUrl, hangupUrl: `${plivo.webhookBase()}/api/webhooks/plivo/hangup` });
    const appId = app?.app_id;
    if (appId) await plivo.attachApplication(row.e164, appId);
    const updated = await db.one('UPDATE phone_numbers SET "answerUrlOverride"=$2, "updatedAt"=now() WHERE id=$1 RETURNING *', [row.id, answerUrl]);
    await logAudit({ action: 'number.bind', targetType: 'PhoneNumber', targetId: row.id, metadata: { answerUrl, appId } });
    res.json({ number: updated });
  }));

  r.patch('/:id', wrap(async (req, res) => {
    const organizationId = await orgId();
    const body = req.body || {};
    const row = await db.one(`
      UPDATE phone_numbers SET
        "friendlyName" = coalesce($3, "friendlyName"),
        "recordCalls" = coalesce($4, "recordCalls"),
        "transcribeEnabled" = coalesce($5, "transcribeEnabled"),
        "transcriptionLanguage" = coalesce($6, "transcriptionLanguage"),
        "forwardTo" = coalesce($7, "forwardTo"),
        "voicemailEnabled" = coalesce($8, "voicemailEnabled"),
        "updatedAt" = now()
      WHERE id = $1 AND "organizationId" = $2 RETURNING *`,
      [requireId(req.params.id, 'number id'), organizationId,
       text(body.friendlyName, { max: 120 }),
       body.recordCalls === undefined ? null : bool(body.recordCalls),
       body.transcribeEnabled === undefined ? null : bool(body.transcribeEnabled),
       text(body.transcriptionLanguage, { max: 20 }),
       text(body.forwardTo, { max: 30 }),
       body.voicemailEnabled === undefined ? null : bool(body.voicemailEnabled)]);
    if (!row) throw fail(404, 'no such number');
    await logAudit({ action: 'number.update', targetType: 'PhoneNumber', targetId: row.id, metadata: body });
    res.json({ number: row });
  }));

  /** Give the number back to the carrier. */
  r.delete('/:id', wrap(async (req, res) => {
    const organizationId = await orgId();
    const row = await db.one('SELECT * FROM phone_numbers WHERE id = $1 AND "organizationId" = $2', [requireId(req.params.id, 'number id'), organizationId]);
    if (!row) throw fail(404, 'no such number');
    const out = await plivo.releaseNumber(row.e164).catch(e => ({ error: e.message }));
    if (out?.error) throw fail(502, `the carrier refused to release ${row.e164}: ${out.error}`);
    await db.query(`UPDATE phone_numbers SET status='released', "releasedAt"=now(), "updatedAt"=now() WHERE id=$1`, [row.id]);
    await logAudit({ action: 'number.release', targetType: 'PhoneNumber', targetId: row.id, metadata: { number: row.e164 } });
    res.json({ ok: true });
  }));

  return r;
};
