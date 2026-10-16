// Recording vault — every call Plivo recorded, plus the audio itself.
//
// The carrier's URL is never exposed to the browser: playback goes through a short-lived signed link
// (lib/media.mjs) that the stream route verifies, and the bytes are proxied from Plivo.
import express from 'express';
import { db, orgId } from '../db/index.mjs';
import { wrap, fail, requireId, text } from './http.mjs';
import { logAudit } from '../lib/audit.mjs';
import { signedMediaUrl, verifySignedMediaRequest } from '../lib/media.mjs';
import { fetchAudioFromUrl } from '../lib/transcribe.mjs';
import * as plivo from '../lib/plivo.mjs';
import { collectRecordings } from './calls.mjs';
import { transcribeRecording } from './transcriptions.mjs';

const shape = r => ({ ...r, playUrl: signedMediaUrl(r.id) });

export const recordingsRouter = () => {
  const r = express.Router();

  r.get('/', wrap(async (req, res) => {
    const organizationId = await orgId();
    const params = [organizationId];
    const where = ['g."organizationId" = $1'];
    if (req.query.callId) { params.push(String(req.query.callId)); where.push(`g."callId" = $${params.length}`); }
    if (req.query.search) {
      params.push(`%${String(req.query.search).trim()}%`);
      where.push(`(coalesce(ct.name,'') ILIKE $${params.length} OR coalesce(c."to",'') ILIKE $${params.length} OR coalesce(c."from",'') ILIKE $${params.length})`);
    }
    if (req.query.pending === 'true') where.push(`NOT EXISTS (SELECT 1 FROM transcriptions t WHERE t."recordingId" = g.id AND t.text IS NOT NULL)`);

    const recordings = await db.many(`
      SELECT g.*, c.direction, c."from", c."to", c."startedAt" AS "callStartedAt", ct.name AS "contactName",
             (SELECT t.id FROM transcriptions t WHERE t."recordingId" = g.id AND t.text IS NOT NULL ORDER BY t."createdAt" DESC LIMIT 1) AS "transcriptionId",
             (SELECT t."wordCount" FROM transcriptions t WHERE t."recordingId" = g.id AND t.text IS NOT NULL ORDER BY t."createdAt" DESC LIMIT 1) AS "transcriptWords"
      FROM recordings g
      LEFT JOIN calls c ON c.id = g."callId"
      LEFT JOIN contacts ct ON ct."organizationId" = g."organizationId" AND (ct.phone = c."from" OR ct.phone = c."to")
      WHERE ${where.join(' AND ')}
      ORDER BY g."createdAt" DESC
      LIMIT ${Math.min(300, Number(req.query.limit) || 100)}`, params);

    const totals = await db.one(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM transcriptions t WHERE t."recordingId" = recordings.id AND t.text IS NOT NULL))::int AS "notTranscribed",
             coalesce(sum("durationSeconds"),0)::int AS seconds
      FROM recordings WHERE "organizationId" = $1`, [organizationId]);

    res.json({ recordings: recordings.map(shape), totals, transcriptionConfigured: !!process.env.OPENAI_API_KEY });
  }));

  r.get('/:id', wrap(async (req, res) => {
    const recording = await load(req.params.id);
    const transcriptions = await db.many('SELECT * FROM transcriptions WHERE "recordingId" = $1 ORDER BY "createdAt" DESC', [recording.id]);
    const call = recording.callId ? await db.one('SELECT * FROM calls WHERE id = $1', [recording.callId]) : null;
    res.json({ recording: shape(recording), transcriptions, call });
  }));

  /** Stream the audio through the office, so the carrier URL stays on the server. */
  r.get('/:id/stream', wrap(async (req, res) => {
    const id = requireId(req.params.id, 'recording id');
    const expires = Number(req.query.expires);
    const signature = String(req.query.signature || '');
    if (!verifySignedMediaRequest(id, expires, signature)) throw fail(403, 'this playback link has expired — reopen the recording');

    const recording = await db.one('SELECT * FROM recordings WHERE id = $1 AND "organizationId" = $2', [id, await orgId()]);
    if (!recording) throw fail(404, 'no such recording');
    if (!recording.recordingUrl) throw fail(409, 'this recording has no audio on the carrier');

    const { buffer, filename } = await fetchAudioFromUrl(recording.recordingUrl);
    res.setHeader('Content-Type', filename.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.end(buffer);
  }));

  /** Ask the carrier for the recordings on a call again (a recording can land minutes late). */
  r.post('/sync/:callId', wrap(async (req, res) => {
    const call = await db.one('SELECT * FROM calls WHERE id = $1 AND "organizationId" = $2', [requireId(req.params.callId, 'call id'), await orgId()]);
    if (!call) throw fail(404, 'no such call');
    const saved = await collectRecordings(call);
    await logAudit({ action: 'recording.sync', targetType: 'Call', targetId: call.id, metadata: { found: saved.length } });
    res.json({ ok: true, added: saved.length, recordings: saved.map(shape) });
  }));

  /** Transcribe this recording with OpenAI and file the text. */
  r.post('/:id/transcribe', wrap(async (req, res) => {
    const recording = await load(req.params.id);
    const body = req.body || {};
    const transcription = await transcribeRecording(recording, {
      model: text(body.model, { max: 60 }) || undefined,
      language: text(body.language, { max: 20 }) || undefined,
      prompt: text(body.prompt, { max: 800 }) || undefined,
    });
    res.status(201).json({ transcription });
  }));

  /** Forget a recording locally (the carrier keeps its own copy). */
  r.delete('/:id', wrap(async (req, res) => {
    const recording = await load(req.params.id);
    await db.query('DELETE FROM transcriptions WHERE "recordingId" = $1', [recording.id]);
    await db.query('DELETE FROM recordings WHERE id = $1', [recording.id]);
    await logAudit({ action: 'recording.delete', targetType: 'Recording', targetId: recording.id, metadata: { plivoRecordingId: recording.plivoRecordingId } });
    res.json({ ok: true });
  }));

  /** Delete it at the carrier too — for recordings that should not exist anywhere. */
  r.delete('/:id/carrier', wrap(async (req, res) => {
    const recording = await load(req.params.id);
    const out = await plivo.deleteRecording(recording.plivoRecordingId).catch(e => ({ error: e.message }));
    await db.query('UPDATE recordings SET status = $2 WHERE id = $1', [recording.id, out?.error ? recording.status : 'deleted']);
    await logAudit({ action: 'recording.delete_carrier', targetType: 'Recording', targetId: recording.id, result: out?.error ? 'failure' : 'success', metadata: out });
    res.json({ ok: !out?.error, detail: out });
  }));

  return r;
};

async function load(id) {
  const recording = await db.one('SELECT * FROM recordings WHERE id = $1 AND "organizationId" = $2', [requireId(id, 'recording id'), await orgId()]);
  if (!recording) throw fail(404, 'no such recording');
  return recording;
}
