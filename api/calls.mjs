// Call desk — placing the call, watching it, and pulling the carrier's record of it afterwards.
//
// The call is what starts everything: Plivo answers it with the XML this app returns, records the
// line, and posts the recording back. From there the recording vault, the transcriber and the trip
// designer each take their turn.
import crypto from 'node:crypto';
import express from 'express';
import { db, orgId, newId } from '../db/index.mjs';
import { wrap, fail, requireId, text, phoneNumber, bool } from './http.mjs';
import { logAudit } from '../lib/audit.mjs';
import * as plivo from '../lib/plivo.mjs';

/** Create or refresh a call row from a Plivo webhook payload. */
export async function upsertCallFromWebhook(body, { organizationId }) {
  const uuid = body.CallUUID || body.call_uuid || null;
  const requestUuid = body.RequestUUID || body.request_uuid || null;
  const direction = (body.Direction || body.call_direction || body.direction || 'outbound') === 'inbound' ? 'inbound' : 'outbound';
  const from = body.From || body.from_number || body.from || '';
  const to = body.To || body.to_number || body.to || '';
  const status = body.CallStatus || body.call_status || body.Event || body.event || null;

  let call = null;
  if (uuid) call = await db.one('SELECT * FROM calls WHERE "plivoCallUuid" = $1', [uuid]);
  if (!call && requestUuid) call = await db.one('SELECT * FROM calls WHERE "requestUuid" = $1 AND "organizationId" = $2', [requestUuid, organizationId]);
  if (!call && uuid) {
    // A call we did not place (someone rang the office): the first webhook is where it appears.
    call = await db.one(
      `INSERT INTO calls (id,"organizationId","plivoCallUuid","requestUuid",direction,status,"from","to","startedAt",rawPayload,"updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(),$9, now()) RETURNING *`,
      [newId(), organizationId, uuid, requestUuid, direction, status || 'queued', from, to, JSON.stringify(body)]);
    return call;
  }
  if (!call) return null;

  const patch = {
    status: status || call.status,
    rawPayload: JSON.stringify(body),
  };
  if (uuid && call.plivoCallUuid !== uuid) patch.plivoCallUuid = uuid;

  call = await db.one(
    `UPDATE calls SET status=$2, "plivoCallUuid"=coalesce($3,"plivoCallUuid"), "endedAt"=$4, "durationSeconds"=coalesce($5,"durationSeconds"),
       "hangupCauseName"=coalesce($6,"hangupCauseName"), rawPayload=$7, "updatedAt"=now()
     WHERE id=$1 RETURNING *`,
    [call.id, patch.status, patch.plivoCallUuid || null,
     body.Duration ? new Date() : call.endedAt,
     body.Duration ? Number(body.Duration) : null,
     body.HangupCauseName || body.hangup_cause_name || null,
     patch.rawPayload]);
  return call;
}

export const callsRouter = () => {
  const r = express.Router();

  r.get('/', wrap(async (req, res) => {
    const organizationId = await orgId();
    const params = [organizationId];
    const where = ['c."organizationId" = $1'];
    if (req.query.direction) { params.push(String(req.query.direction)); where.push(`c.direction = $${params.length}`); }
    if (req.query.status) { params.push(String(req.query.status)); where.push(`c.status = $${params.length}`); }
    if (req.query.contactId) {
      params.push(String(req.query.contactId));
      where.push(`EXISTS (SELECT 1 FROM contacts t WHERE t.id = $${params.length} AND (t.phone = c."from" OR t.phone = c."to"))`);
    }
    if (req.query.search) {
      params.push(`%${String(req.query.search).trim()}%`);
      where.push(`(coalesce(ct.name,'') ILIKE $${params.length} OR c."from" ILIKE $${params.length} OR c."to" ILIKE $${params.length} OR coalesce(c."plivoCallUuid",'') ILIKE $${params.length})`);
    }
    const limit = Math.min(200, Number(req.query.limit) || 60);

    const calls = await db.many(`
      SELECT c.id, c.direction, c.status, c."from", c."to", c."startedAt", c."endedAt", c."durationSeconds",
             c."totalCost", c."hangupCauseName", c."recordingEnabled", c."transcriptionEnabled", c."plivoCallUuid",
             c."createdAt",
             ct.id AS "contactId", ct.name AS "contactName",
             (SELECT count(*)::int FROM recordings rg WHERE rg."callId" = c.id) AS "recordingCount",
             (SELECT count(*)::int FROM transcriptions t WHERE t."callId" = c.id AND t.text IS NOT NULL) AS "transcriptCount",
             (SELECT l.id FROM leads l WHERE l."callId" = c.id ORDER BY l."createdAt" DESC LIMIT 1) AS "leadId",
             (SELECT l.status FROM leads l WHERE l."callId" = c.id ORDER BY l."createdAt" DESC LIMIT 1) AS "leadStatus"
      FROM calls c
      LEFT JOIN contacts ct ON ct."organizationId" = c."organizationId" AND (ct.phone = c."from" OR ct.phone = c."to")
      WHERE ${where.join(' AND ')}
      ORDER BY c."startedAt" DESC
      LIMIT $${params.length + 1}`, [...params, limit]);

    const totals = await db.one(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE status IN ('completed','in-progress','ringing','queued'))::int AS active,
             coalesce(sum("durationSeconds"),0)::int AS seconds
      FROM calls WHERE "organizationId" = $1`, [organizationId]);

    res.json({ calls, totals });
  }));

  r.get('/:id', wrap(async (req, res) => {
    const id = requireId(req.params.id, 'call id');
    const organizationId = await orgId();
    const call = await db.one('SELECT * FROM calls WHERE id = $1 AND "organizationId" = $2', [id, organizationId]);
    if (!call) throw fail(404, 'no such call');
    const [recordings, transcriptions, events, lead, contact] = await Promise.all([
      db.many('SELECT * FROM recordings WHERE "callId" = $1 ORDER BY "createdAt"', [id]),
      db.many('SELECT * FROM transcriptions WHERE "callId" = $1 ORDER BY "createdAt" DESC', [id]),
      db.many('SELECT id, "eventType", status, "occurredAt", payload FROM call_events WHERE "callId" = $1 ORDER BY "occurredAt"', [id]),
      db.one('SELECT * FROM leads WHERE "callId" = $1 ORDER BY "createdAt" DESC LIMIT 1', [id]),
      db.one('SELECT * FROM contacts WHERE "organizationId" = $1 AND (phone = $2 OR phone = $3) LIMIT 1', [organizationId, call.from, call.to]),
    ]);
    res.json({ call, recordings, transcriptions, events, lead, contact });
  }));

  /**
   * Place a call. `to` may be a contact id or a number; `mode` decides what Plivo is told to do when
   * the guest picks up: 'message' (greet, record their brief) or 'browser' (bridge to the softphone
   * in this page so a human talks to them).
   */
  r.post('/', wrap(async (req, res) => {
    const organizationId = await orgId();
    const body = req.body || {};

    let to = phoneNumber(body.to, { field: 'number' });
    let contact = null;
    if (body.contactId) {
      contact = await db.one('SELECT * FROM contacts WHERE id = $1 AND "organizationId" = $2', [String(body.contactId), organizationId]);
      if (!contact) throw fail(404, 'no such contact');
      to = contact.phone;
      if (!to) throw fail(400, `${contact.name} has no phone number`);
    }
    if (!to) throw fail(400, 'pick a contact or type a number to call');

    if (!plivo.configured()) throw fail(400, 'Plivo is not configured — add the credentials to .env first');

    const base = plivo.webhookBase();
    const reach = await plivo.checkReachable(base);
    if (!reach.ok && !bool(body.force)) {
      throw fail(400, `Plivo cannot reach this office at ${base || '(no public URL set)'} — ${reach.reason}. Set PUBLIC_URL to your tunnel, or pass force to dial anyway.`);
    }

    const from = String(body.from || plivo.callerId() || '').trim();
    if (!from) throw fail(400, 'there is no caller id — set PLIVO_CALLER_ID or pick a number');

    const mode = body.mode === 'browser' ? 'browser' : 'message';
    const answerUrl = `${base}/api/webhooks/plivo/answer?mode=${mode}`;
    const placed = await plivo.placeCall({
      to,
      from,
      answerUrl,
      ringUrl: `${base}/api/webhooks/plivo/ring`,
      hangupUrl: `${base}/api/webhooks/plivo/hangup`,
      machineDetection: bool(body.machineDetection) ? 'true' : undefined,
      timeLimit: Number(body.timeLimit) || 3600,
    });

    const call = await db.one(`
      INSERT INTO calls (id,"organizationId","plivoCallUuid","requestUuid",direction,status,"from","to","startedAt",
                         "recordingEnabled","transcriptionEnabled","requestedMode","requestedParams","updatedAt")
      VALUES ($1,$2,$3,$4,'outbound','queued',$5,$6, now(), $7,$8,$9,$10, now())
      RETURNING *`,
      [newId(), organizationId, `request_${placed.requestUuid || crypto.randomUUID()}`, placed.requestUuid, from, to,
       true, true, mode,
       JSON.stringify({ contactId: contact?.id || null, contactName: contact?.name || null, requestedBy: body.by || 'Holiday desk' })]);

    await logAudit({
      action: 'call.place', targetType: 'Call', targetId: call.id,
      metadata: { to, from, mode, contact: contact?.name || null, requestUuid: placed.requestUuid },
    });
    res.status(201).json({ call, placed });
  }));

  r.post('/:id/hangup', wrap(async (req, res) => {
    const call = await loadCall(req.params.id);
    await plivo.hangup(call.plivoCallUuid);
    await db.query(`UPDATE calls SET status='completed', "endedAt"=now(), "updatedAt"=now() WHERE id=$1`, [call.id]);
    await logAudit({ action: 'call.hangup', targetType: 'Call', targetId: call.id });
    res.json({ ok: true });
  }));

  r.post('/:id/record/:action(start|stop)', wrap(async (req, res) => {
    const call = await loadCall(req.params.id);
    if (req.params.action === 'start') {
      await plivo.startRecording(call.plivoCallUuid, { format: 'mp3' });
      await db.query(`UPDATE calls SET "recordingEnabled"=true, "updatedAt"=now() WHERE id=$1`, [call.id]);
    } else {
      await plivo.stopRecording(call.plivoCallUuid);
    }
    await logAudit({ action: `call.record_${req.params.action}`, targetType: 'Call', targetId: call.id });
    res.json({ ok: true });
  }));

  r.post('/:id/speak', wrap(async (req, res) => {
    const call = await loadCall(req.params.id);
    const said = text((req.body || {}).text, { required: true, field: 'text', max: 800 });
    await plivo.speak(call.plivoCallUuid, said);
    await logAudit({ action: 'call.speak', targetType: 'Call', targetId: call.id, metadata: { text: said } });
    res.json({ ok: true });
  }));

  r.post('/:id/digits', wrap(async (req, res) => {
    const call = await loadCall(req.params.id);
    const digits = text((req.body || {}).digits, { required: true, field: 'digits', max: 40 });
    await plivo.sendDigits(call.plivoCallUuid, digits);
    res.json({ ok: true });
  }));

  /** Pull the carrier's version of this call: status, duration, cost, hangup cause, and recordings. */
  r.post('/:id/sync', wrap(async (req, res) => {
    const call = await loadCall(req.params.id);
    const uuid = call.plivoCallUuid?.startsWith('request_') ? null : call.plivoCallUuid;
    let detail = null;
    if (uuid) {
      detail = await plivo.call(uuid).catch(e => ({ error: e.message }));
    }
    if (detail && !detail.error) {
      await db.query(`
        UPDATE calls SET status=$2, "durationSeconds"=$3, "billDurationSeconds"=$4, "totalCost"=$5,
          "hangupCauseCode"=$6, "hangupCauseName"=$7, "hangupSource"=$8, "answeredAt"=coalesce($9,"answeredAt"),
          "endedAt"=coalesce($10,"endedAt"), "updatedAt"=now()
        WHERE id=$1`,
        [call.id, detail.call_status || call.status, Number(detail.call_duration) || call.durationSeconds,
         Number(detail.bill_duration) || call.billDurationSeconds, detail.total_amount ?? call.totalCost,
         Number(detail.hangup_cause_code) || null, detail.hangup_cause_name || null, detail.hangup_source || null,
         detail.answer_time ? new Date(detail.answer_time) : null,
         detail.end_time ? new Date(detail.end_time) : null]);
    }
    const collected = await collectRecordings(call);
    await logAudit({ action: 'call.sync', targetType: 'Call', targetId: call.id, metadata: { recordings: collected.length } });
    const fresh = await db.one('SELECT * FROM calls WHERE id = $1', [call.id]);
    res.json({ call: fresh, recordings: collected, detail });
  }));

  return r;
};

async function loadCall(id) {
  const call = await db.one('SELECT * FROM calls WHERE id = $1 AND "organizationId" = $2', [requireId(id, 'call id'), await orgId()]);
  if (!call) throw fail(404, 'no such call');
  return call;
}

/** Ask Plivo what it recorded on this call and store anything new. */
export async function collectRecordings(call) {
  const uuid = call.plivoCallUuid?.startsWith('request_') ? null : call.plivoCallUuid;
  if (!uuid) return [];
  let remote = [];
  try {
    remote = await plivo.recordings(uuid);
  } catch (e) {
    console.warn('[call desk] could not list recordings:', e.message);
    return [];
  }
  const saved = [];
  for (const rec of remote) {
    const recordingId = rec.recording_id || rec.recordingId;
    if (!recordingId) continue;
    const url = rec.recording_url || rec.record_url || null;
    const row = await db.one(`
      INSERT INTO recordings (id,"organizationId","callId","plivoRecordingId","recordingUrl","durationSeconds","fileFormat","channelType","status","startedAt","endedAt","rawPayload")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT ("plivoRecordingId") DO UPDATE SET
        "recordingUrl" = EXCLUDED."recordingUrl",
        "durationSeconds" = coalesce(EXCLUDED."durationSeconds", recordings."durationSeconds"),
        "status" = EXCLUDED."status",
        "rawPayload" = EXCLUDED."rawPayload"
      RETURNING *`,
      [newId(), call.organizationId, call.id, recordingId, url,
       Math.round((Number(rec.recording_duration_ms) || 0) / 1000) || null,
       rec.recording_format || 'mp3', rec.channel_type || null,
       rec.recording_state === 'deleted' ? 'deleted' : 'completed',
       rec.recording_start_ms ? new Date(Number(rec.recording_start_ms)) : null,
       rec.recording_end_ms ? new Date(Number(rec.recording_end_ms)) : null,
       JSON.stringify(rec)]);
    saved.push(row);
  }
  return saved;
}
