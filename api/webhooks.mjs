// Call webhooks — how Plivo tells the office what happened, and how the office controls the call.
//
// Every handler validates the V3 signature first (the body is untrusted input), records the raw
// payload for idempotency, then answers with Plivo XML. A handler must never 500: Plivo retries, and a
// retried payload that was already processed would file a duplicate recording.
import express from 'express';
import crypto from 'node:crypto';
import { db, env, orgId, newId } from '../db/index.mjs';
import { wrap } from './http.mjs';
import { verifyV3Signature } from '../lib/plivo-signature.mjs';
import { answerXml, emptyXml } from '../lib/plivo-xml.mjs';
import { upsertCallFromWebhook } from './calls.mjs';
import { cancelFollowupsForLead } from '../lib/followup.mjs';
import { bus } from '../lib/events.mjs';
import * as plivo from '../lib/plivo.mjs';

const xml = res => res.type('application/xml; charset=utf-8');

/** Store the raw webhook; returns null when this exact payload was already handled. */
async function recordWebhook({ req, kind, dedupeKey, signatureValid }) {
  const organizationId = await orgId().catch(() => null);
  try {
    const row = await db.one(
      `INSERT INTO webhook_events (id,"organizationId",provider,kind,"eventType","dedupeKey","signatureValid",headers,"rawBody","contentType","sourceIp",status)
       VALUES ($1,$2,'plivo',$3,$4,$5,$6,$7,$8,$9,$10,'received')
       ON CONFLICT (provider,"dedupeKey",kind) DO NOTHING
       RETURNING id`,
      [newId(), organizationId, kind, req.body?.Event || req.body?.event || null, dedupeKey, signatureValid,
       JSON.stringify(req.headers), typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}),
       req.headers['content-type'] || null, req.ip || null]);
    return row?.id || null;
  } catch (e) {
    console.warn('[webhook] could not file the event:', e.message);
    return null;
  }
}

/**
 * Validate + dedupe in one place. When PLIVO_WEBHOOK_AUTH_TOKEN is set the signature is required;
 * without it the office accepts the call but marks the event as unverified, so nothing is silently
 * trusted on a misconfigured deployment.
 */
async function accept(req, kind) {
  const body = req.body || {};
  const dedupeKey = body.CallUUID || body.call_uuid || body.RecordingID || body.recording_id || body.RequestUUID || crypto.randomUUID();
  const token = env.PLIVO_WEBHOOK_AUTH_TOKEN;
  const nonce = req.get('X-Plivo-Signature-V3-Nonce') || req.get('x-plivo-signature-v3-nonce');
  const signature = req.get('X-Plivo-Signature-V3') || req.get('x-plivo-signature-v3');
  const url = `${plivo.webhookBase() || `${req.protocol}://${req.get('host')}`}${req.originalUrl}`;
  const signatureValid = token
    ? verifyV3Signature({ method: req.method, url, nonce, authToken: token, signature, params: body })
    : false;

  if (token && !signatureValid) {
    const err = new Error('the webhook signature did not verify');
    err.status = 403;
    throw err;
  }
  const webhookEventId = await recordWebhook({ req, kind, dedupeKey, signatureValid });
  return { body, webhookEventId };
}

export const webhooksRouter = () => {
  const r = express.Router();

  /**
   * Plivo fetches this the moment the call is answered — the whole call is controlled from here.
   * ?mode=browser bridges the guest to this office's softphone (record on the Dial); the default
   * greets them and records their brief.
   */
  r.post('/plivo/answer', wrap(async (req, res) => {
    const { body } = await accept(req, 'answer');
    const organizationId = await orgId();
    const call = await upsertCallFromWebhook(body, { organizationId });
    const mode = String(req.query.mode || 'message');
    const base = plivo.webhookBase();

    if (call) {
      await db.query(`UPDATE calls SET "requestedMode"=coalesce("requestedMode",$2), "recordingEnabled"=true, "updatedAt"=now() WHERE id=$1`, [call.id, mode]);
      await db.query(
        `INSERT INTO call_events (id,"organizationId","callId","eventType",status,payload,"occurredAt")
         VALUES ($1,$2,$3,'answer','in-progress',$4, now())`,
        [newId(), organizationId, call.id, JSON.stringify({ mode, from: body.From, to: body.To })]);
    }

    if (mode === 'browser') {
      const endpoint = await plivo.latestEndpoint().catch(() => null);
      if (endpoint?.username) {
        return xml(res).send(answerXml({
          greeting: 'Please hold while I connect you to the travel desk.',
          language: 'en-IN',
          dial: {
            sip: endpoint.sipUri || `sip:${endpoint.username}@phone.plivo.com`,
            callerId: plivo.callerId(),
            timeLimit: 3600,
            record: 'true',
            callbackUrl: `${base}/api/webhooks/plivo/record`,
          },
          hangup: true,
        }));
      }
      console.warn('[call desk] browser mode asked for but the account has no SIP endpoint — taking a message instead');
    }

    xml(res).send(answerXml({
      greeting: 'Thank you for calling 3dots Travel. After the beep, tell me where you would like to go, your dates, and how many are travelling. I will have an itinerary ready for you.',
      language: 'en-IN',
      record: {
        action: `${base}/api/webhooks/plivo/record`,
        maxLength: 600,
        playBeep: true,
        transcriptionType: 'auto',
        recordChannelType: 'mono',
      },
      hangup: true,
    }));
  }));

  /** Ringing: file it on the timeline. */
  r.post('/plivo/ring', wrap(async (req, res) => {
    const { body } = await accept(req, 'ring');
    const organizationId = await orgId();
    const call = await upsertCallFromWebhook(body, { organizationId });
    if (call) {
      await db.query(`UPDATE calls SET status = coalesce(nullif($2,''),'ringing'), "updatedAt"=now() WHERE id=$1`, [call.id, body.CallStatus || 'ringing']);
      await db.query(
        `INSERT INTO call_events (id,"organizationId","callId","eventType",status,payload,"occurredAt")
         VALUES ($1,$2,$3,'ring',$4,$5, now())`,
        [newId(), organizationId, call.id, body.CallStatus || 'ringing', JSON.stringify(body)]);
    }
    xml(res).send(emptyXml());
  }));

  /**
   * The finished recording. This is the hand-off point: the row lands in the vault, and the
   * transcription desk picks it up from there.
   */
  r.post('/plivo/record', wrap(async (req, res) => {
    const { body } = await accept(req, 'recording');
    const organizationId = await orgId();

    const recordingId = body.RecordingID || body.recording_id || null;
    const url = body.RecordUrl || body.record_url || body.recording_url || null;
    const duration = Number(body.RecordingDuration || body.recording_duration || 0) || null;
    const callUuid = body.CallUUID || body.call_uuid || null;

    let call = callUuid ? await db.one('SELECT * FROM calls WHERE "plivoCallUuid" = $1', [callUuid]) : null;
    if (!call) call = await upsertCallFromWebhook(body, { organizationId });

    if (recordingId && url) {
      const recording = await db.one(`
        INSERT INTO recordings (id,"organizationId","callId","plivoRecordingId","recordingUrl","durationSeconds","fileFormat","channelType",status,rawPayload)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'completed',$9)
        ON CONFLICT ("plivoRecordingId") DO UPDATE SET "recordingUrl"=EXCLUDED."recordingUrl",
          "durationSeconds"=coalesce(EXCLUDED."durationSeconds", recordings."durationSeconds"), rawPayload=EXCLUDED."rawPayload"
        RETURNING id`,
        [newId(), organizationId, call?.id || null, recordingId, url, duration,
         body.RecordFileFormat || body.recording_format || 'mp3', body.RecordChannelType || null, JSON.stringify(body)]);
      if (call) {
        await db.query(`UPDATE calls SET "recordingEnabled"=true, "endedAt"=coalesce("endedAt", now()), "durationSeconds"=coalesce($2,"durationSeconds"), "updatedAt"=now() WHERE id=$1`, [call.id, duration]);
        await db.query(
          `INSERT INTO call_events (id,"organizationId","callId","eventType",status,payload,"occurredAt")
           VALUES ($1,$2,$3,'recording','completed',$4, now())`,
          [newId(), organizationId, call.id, JSON.stringify({ recordingId, seconds: duration, recordingRowId: recording.id })]);
      }
    }
    xml(res).send(emptyXml());
  }));

  /** Hangup: pull the carrier's final numbers. */
  r.post('/plivo/hangup', wrap(async (req, res) => {
    const { body } = await accept(req, 'hangup');
    const organizationId = await orgId();
    const call = await upsertCallFromWebhook(body, { organizationId });
    if (call) {
      let detail = null;
      if (plivo.configured() && call.plivoCallUuid && !call.plivoCallUuid.startsWith('request_')) {
        detail = await plivo.call(call.plivoCallUuid).catch(() => null);
      }
      await db.query(`
        UPDATE calls SET status='completed', "endedAt"=coalesce("endedAt", now()),
          "durationSeconds"=coalesce($2,"durationSeconds"), "totalCost"=coalesce($3,"totalCost"),
          "hangupCauseName"=coalesce($4,"hangupCauseName"), "hangupCauseCode"=coalesce($5,"hangupCauseCode"), "updatedAt"=now()
        WHERE id=$1`,
        [call.id, Number(body.Duration) || (detail ? Number(detail.call_duration) || null : null),
         detail?.total_amount ?? null, body.HangupCauseName || detail?.hangup_cause_name || null,
         Number(body.HangupCauseCode) || (detail ? Number(detail.hangup_cause_code) || null : null)]);
      await db.query(
        `INSERT INTO call_events (id,"organizationId","callId","eventType",status,payload,"occurredAt")
         VALUES ($1,$2,$3,'hangup','completed',$4, now())`,
        [newId(), organizationId, call.id, JSON.stringify({ ...body, carrier: detail })]);
    }
    xml(res).send(emptyXml());
  }));

  /** Plivo's own transcription callback (used when the carrier does the speech-to-text instead). */
  r.post('/transcription', wrap(async (req, res) => {
    const { body } = await accept(req, 'transcription');
    const organizationId = await orgId();
    const status = body.transcription_status || body.TranscriptionStatus || 'completed';
    const recordingId = body.recording_id || body.RecordingID || null;
    const recording = recordingId
      ? await db.one('SELECT * FROM recordings WHERE "plivoRecordingId" = $1', [recordingId])
      : null;

    const existing = recording
      ? await db.one('SELECT id FROM transcriptions WHERE "recordingId" = $1 ORDER BY "createdAt" DESC LIMIT 1', [recording.id])
      : null;

    const text = body.transcription_text || body.TranscriptionText || '';
    if (existing) {
      await db.query(
        `UPDATE transcriptions SET text=$2, status=$3, source='callback', "updatedAt"=now() WHERE id=$1`,
        [existing.id, text || null, status]);
    } else {
      await db.query(`
        INSERT INTO transcriptions (id,"organizationId","recordingId","callId","plivoTranscriptionId",type,status,text,source,"updatedAt")
        VALUES ($1,$2,$3,$4,$5,'transcription',$6,$7,'callback', now())`,
        [newId(), organizationId, recording?.id || null, recording?.callId || null,
         body.transcription_uuid || `plivo_${crypto.randomBytes(6).toString('hex')}`, status, text || null]);
    }
    res.json({ ok: true });
  }));

  /** Inbound WhatsApp / SMS customer reply callback */
  r.post('/message', wrap(async (req, res) => {
    const { body } = await accept(req, 'message').catch(() => ({ body: req.body || {} }));
    const organizationId = await orgId();
    const from = String(body.From || body.from || '');
    const to = String(body.To || body.to || '');
    const text = String(body.Text || body.text || body.body || '');

    console.log(`[webhook:message] received from ${from}: ${text.slice(0, 50)}`);

    if (from) {
      const cleanPhone = from.replace(/\D/g, '');
      // 1. Direct cancellation by targetId (phone)
      await db.query(`
        UPDATE scheduled_followups
        SET status = 'cancelled', error = 'Customer replied to message', "updatedAt" = now()
        WHERE "organizationId" = $1 AND ("targetId" = $2 OR "targetId" LIKE $3) AND status = 'pending'
      `, [organizationId, from, `%${cleanPhone.slice(-10)}`]);

      // 2. Cancellation by linked contact
      const contact = await db.one(`
        SELECT id FROM contacts 
        WHERE "organizationId" = $1 AND (phone = $2 OR phone LIKE $3)
        LIMIT 1
      `, [organizationId, from, `%${cleanPhone.slice(-10)}`]);

      if (contact) {
        const openLead = await db.one(`
          SELECT id FROM leads 
          WHERE "contactId" = $1 AND status IN ('quote_sent', 'pending_approval', 'approved', 'negotiation')
          ORDER BY "updatedAt" DESC LIMIT 1
        `, [contact.id]);

        if (openLead) {
          await cancelFollowupsForLead({ organizationId, leadId: openLead.id, reason: 'Customer replied to message' });
        }
      }

      bus.broadcast('message.replied', { organizationId, from, text });
    }

    res.json({ ok: true });
  }));

  return r;
};
