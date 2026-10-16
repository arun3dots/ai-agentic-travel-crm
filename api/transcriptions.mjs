// Transcriber desk — the call recording, in words.
//
// OpenAI Whisper does the work; the row it writes is what the trip designer reads next. A
// transcription is written per recording so a re-run replaces the text rather than piling up copies.
import crypto from 'node:crypto';
import express from 'express';
import { db, orgId, newId } from '../db/index.mjs';
import { wrap, fail, requireId, text } from './http.mjs';
import { logAudit } from '../lib/audit.mjs';
import { transcribeRecordingUrl, normalizeToIso639_1, transcriptionConfigured } from '../lib/transcribe.mjs';

/**
 * Run Whisper over one recording row and file the result.
 * @param {object} recording  a row from `recordings`
 */
export async function transcribeRecording(recording, { model, language, prompt } = {}) {
  if (!transcriptionConfigured()) throw fail(400, 'OPENAI_API_KEY is not configured — the transcription desk cannot run');
  if (!recording.recordingUrl || !/^https?:/i.test(recording.recordingUrl)) {
    throw fail(400, 'this recording has no carrier URL to transcribe');
  }

  const requestedLanguage = language && language !== 'auto' && language !== 'mixed' ? normalizeToIso639_1(language) : undefined;
  const result = await transcribeRecordingUrl(recording.recordingUrl, { model, language: requestedLanguage, prompt });
  const wordCount = result.text.split(/\s+/).filter(Boolean).length;

  const existing = await db.one('SELECT id FROM transcriptions WHERE "recordingId" = $1 ORDER BY "createdAt" DESC LIMIT 1', [recording.id]);
  const values = [
    result.text, result.language || 'en', wordCount,
    result.segments ? JSON.stringify(result.segments) : null,
    result.rawPayload ? JSON.stringify(result.rawPayload) : null,
  ];

  const transcription = existing
    ? await db.one(
      `UPDATE transcriptions SET text=$2, language=$3, "wordCount"=$4, segments=$5, "rawPayload"=$6,
         status='completed', source='openai_whisper', "errorMessage"=NULL, "updatedAt"=now()
       WHERE id=$1 RETURNING *`, [existing.id, ...values])
    : await db.one(
      `INSERT INTO transcriptions (id,"organizationId","recordingId","callId","plivoTranscriptionId","recordingSid",type,status,language,text,segments,"wordCount",source,"rawPayload","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,'transcription','completed',$7,$8,$9,$10,'openai_whisper',$11, now()) RETURNING *`,
      [newId(), recording.organizationId, recording.id, recording.callId, `whisper_${crypto.randomBytes(8).toString('hex')}`,
       recording.plivoRecordingId, ...values]);

  if (recording.callId) {
    await db.query(
      `UPDATE calls SET "transcriptionEnabled"=true, "transcriptionLanguage"=$2, "updatedAt"=now() WHERE id=$1`,
      [recording.callId, result.language || 'en']);
    await db.query(
      `INSERT INTO call_events (id,"organizationId","callId","eventType",status,payload,"occurredAt")
       VALUES ($1,$2,$3,'transcription.completed','completed',$4, now())`,
      [newId(), recording.organizationId, recording.callId, JSON.stringify({ transcriptionId: transcription.id, words: wordCount, language: result.language })]);
  }

  await logAudit({
    action: 'transcription.create', targetType: 'Recording', targetId: recording.id,
    metadata: { transcriptionId: transcription.id, words: wordCount, language: result.language, model: model || 'whisper-1' },
  });
  return transcription;
}

export const transcriptionsRouter = () => {
  const r = express.Router();

  r.get('/', wrap(async (req, res) => {
    const organizationId = await orgId();
    const params = [organizationId];
    const where = ['t."organizationId" = $1'];
    if (req.query.recordingId) { params.push(String(req.query.recordingId)); where.push(`t."recordingId" = $${params.length}`); }
    if (req.query.callId) { params.push(String(req.query.callId)); where.push(`t."callId" = $${params.length}`); }
    if (req.query.withText === 'true') where.push(`t.text IS NOT NULL AND length(btrim(t.text)) > 1`);
    if (req.query.search) {
      params.push(`%${String(req.query.search).trim()}%`);
      where.push(`(t.text ILIKE $${params.length} OR coalesce(ct.name,'') ILIKE $${params.length} OR coalesce(c."to",'') ILIKE $${params.length})`);
    }

    const transcriptions = await db.many(`
      SELECT t.*, c."from", c."to", c.direction, c."startedAt" AS "callStartedAt", ct.name AS "contactName",
             g."durationSeconds" AS "recordingSeconds", g."plivoRecordingId"
      FROM transcriptions t
      LEFT JOIN recordings g ON g.id = t."recordingId"
      LEFT JOIN calls c ON c.id = t."callId"
      LEFT JOIN contacts ct ON ct."organizationId" = t."organizationId" AND (ct.phone = c."from" OR ct.phone = c."to")
      WHERE ${where.join(' AND ')}
      ORDER BY t."createdAt" DESC
      LIMIT ${Math.min(300, Number(req.query.limit) || 100)}`, params);

    res.json({ transcriptions, transcriptionConfigured: transcriptionConfigured() });
  }));

  r.get('/:id', wrap(async (req, res) => {
    const transcription = await db.one('SELECT * FROM transcriptions WHERE id = $1 AND "organizationId" = $2', [requireId(req.params.id, 'transcription id'), await orgId()]);
    if (!transcription) throw fail(404, 'no such transcription');
    const recording = transcription.recordingId ? await db.one('SELECT * FROM recordings WHERE id = $1', [transcription.recordingId]) : null;
    res.json({ transcription, recording });
  }));

  r.delete('/:id', wrap(async (req, res) => {
    const transcription = await db.one('DELETE FROM transcriptions WHERE id = $1 AND "organizationId" = $2 RETURNING id', [requireId(req.params.id, 'transcription id'), await orgId()]);
    if (!transcription) throw fail(404, 'no such transcription');
    await logAudit({ action: 'transcription.delete', targetType: 'Transcription', targetId: transcription.id });
    res.json({ ok: true });
  }));

  return r;
};
