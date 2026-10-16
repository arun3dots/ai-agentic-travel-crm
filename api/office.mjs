// The office itself: is it healthy, which services are wired, and what does today look like.
import express from 'express';
import { db, env, org } from '../db/index.mjs';
import { wrap } from './http.mjs';
import * as plivo from '../lib/plivo.mjs';
import { transcriptionConfigured } from '../lib/transcribe.mjs';
import { itineraryConfigured } from '../lib/itinerary.mjs';
import { mailConfigured } from '../lib/mail.mjs';

/** Every outside service the desks talk to, and which pods depend on it. */
const POD_KEYS = ['calls', 'record', 'scribe', 'design', 'gate', 'despatch', 'desk'];

function serviceWiring() {
  return [
    { key: 'plivo', name: 'Plivo', pods: ['calls', 'record'], what: 'places and records the call', configured: plivo.configured() },
    { key: 'openai', name: 'OpenAI Whisper', pods: ['scribe'], what: 'turns the recording into text', configured: transcriptionConfigured() },
    { key: 'deepseek', name: 'DeepSeek', pods: ['design'], what: 'writes the itinerary from the transcript', configured: itineraryConfigured() },
    { key: 'resend', name: 'Resend', pods: ['despatch'], what: 'mails the guest and the suppliers', configured: mailConfigured() },
    // the office's own store: every pod reads and writes here, so it belongs on the wiring diagram
    { key: 'database', name: 'Travel DB', pods: POD_KEYS, what: 'holds the calls, transcripts, trips and records', configured: true },
  ];
}

export const officeRouter = () => {
  const r = express.Router();

  r.get('/health', wrap(async (_req, res) => {
    res.json({
      ok: true,
      service: 'travel-office',
      app: 'travel-office',
      office: '3dots Travel — Holiday Desk',
      brand: '3dots Travel',
      database: 'plivo_db',
      telephony: env.TELEPHONY_MODE || 'live',
      time: new Date().toISOString(),
    });
  }));

  /** The dashboard: the numbers the owner actually asks for. */
  r.get('/office', wrap(async (_req, res) => {
    const organization = await org();
    const organizationId = organization.id;
    const counts = await db.one(`
      SELECT
        (SELECT count(*)::int FROM calls WHERE "organizationId"=$1) AS calls,
        (SELECT count(*)::int FROM calls WHERE "organizationId"=$1 AND "startedAt" > now() - interval '7 days') AS "callsThisWeek",
        (SELECT count(*)::int FROM recordings WHERE "organizationId"=$1) AS recordings,
        (SELECT count(*)::int FROM transcriptions WHERE "organizationId"=$1 AND text IS NOT NULL) AS transcriptions,
        (SELECT count(*)::int FROM leads WHERE "organizationId"=$1) AS leads,
        (SELECT count(*)::int FROM leads WHERE "organizationId"=$1 AND status='pending_approval') AS "awaitingApproval",
        (SELECT count(*)::int FROM leads WHERE "organizationId"=$1 AND status IN ('sent_to_customer','sent_to_supplier','converted')) AS "posted",
        (SELECT count(*)::int FROM contacts WHERE "organizationId"=$1) AS contacts,
        (SELECT count(*)::int FROM suppliers WHERE "organizationId"=$1) AS suppliers,
        (SELECT count(*)::int FROM phone_numbers WHERE "organizationId"=$1 AND status='active') AS numbers,
        (SELECT count(*)::int FROM memberships WHERE "organizationId"=$1) AS staff,
        (SELECT coalesce(sum("durationSeconds"),0)::int FROM calls WHERE "organizationId"=$1) AS "talkSeconds"`,
      [organizationId]);

    const pipeline = Object.fromEntries((await db.many(
      'SELECT status, count(*)::int AS n FROM leads WHERE "organizationId" = $1 GROUP BY status', [organizationId]))
      .map(x => [x.status, x.n]));

    const recent = await db.many(`
      SELECT id, action, "targetType", "targetId", result, "createdAt", metadata
      FROM audit_logs WHERE "organizationId" = $1 ORDER BY "createdAt" DESC LIMIT 12`, [organizationId]);

    const awaiting = await db.many(`
      SELECT l.id, l.title, l.destination, l."updatedAt", ct.name AS "contactName", ct.email AS "contactEmail"
      FROM leads l LEFT JOIN contacts ct ON ct.id = l."contactId"
      WHERE l."organizationId" = $1 AND l.status = 'pending_approval'
      ORDER BY l."updatedAt" DESC LIMIT 10`, [organizationId]);

    res.json({
      organization: { id: organization.id, name: organization.name, slug: organization.slug },
      counts, pipeline, services: serviceWiring(), awaiting, recent,
      webhook: { base: plivo.webhookBase() || null, callerId: plivo.callerId() || null },
    });
  }));

  /** Live check: does each service actually answer? Used by the connector strip. */
  r.get('/services', wrap(async (_req, res) => {
    let carrier = { ok: false, reason: 'not configured' };
    if (plivo.configured()) {
      carrier = await plivo.account()
        .then(a => ({ ok: true, name: a?.name, credits: a?.cash_credits, currency: a?.currency }))
        .catch(e => ({ ok: false, reason: e.message }));
    }
    const reach = await plivo.checkReachable().catch(e => ({ ok: false, reason: e.message }));
    res.json({
      services: serviceWiring().map(s => ({ ...s, live: s.key === 'plivo' ? carrier.ok : s.configured })),
      carrier,
      webhook: { base: plivo.webhookBase() || null, ok: !!reach.ok, reason: reach.reason, answerUrl: `${plivo.webhookBase() || ''}/api/webhooks/plivo/answer` },
      checkedAt: new Date().toISOString(),
    });
  }));

  return r;
};
