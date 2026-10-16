// The pipeline — the six stations, in the order the agency works them:
//
//   1 CALL        a contact is chosen and the call goes out through Plivo
//   2 RECORDINGS  the carrier's recording is collected into the vault
//   3 TRANSCRIBE  OpenAI Whisper turns the audio into text
//   4 ITINERARY   the designer reads the transcript and writes the trip
//   5 APPROVAL    a staff member signs it off — the gate
//   6 DESPATCH    the guest's itinerary and the supplier's RFQ go out
//
// There is deliberately no pipeline table. Each station's state is read out of the data itself
// (the call, the recording, the transcription, the lead), so the board can never disagree with
// reality. A "case" is one call with everything attached to it, plus any lead that has no call.
import express from 'express';
import { db, orgId } from '../db/index.mjs';
import { wrap } from './http.mjs';
import { signedMediaUrl } from '../lib/media.mjs';

export const STATIONS = [
  { key: 'call', name: 'Call the guest', pod: 'calls', agent: 'dialer' },
  { key: 'recording', name: 'Collect the recording', pod: 'record', agent: 'archivist' },
  { key: 'transcription', name: 'Transcribe the call', pod: 'scribe', agent: 'scribe' },
  { key: 'itinerary', name: 'Design the itinerary', pod: 'design', agent: 'designer' },
  { key: 'approval', name: 'Staff approval', pod: 'gate', agent: 'gatekeeper' },
  { key: 'despatch', name: 'Mail guest + suppliers', pod: 'despatch', agent: 'courier' },
];

const station = (key, state, detail = {}) => ({ key, state, ...detail });

function buildCase(row) {
  const call = row.callId ? {
    id: row.callId, status: row.callStatus, direction: row.direction,
    from: row.callFrom, to: row.callTo, startedAt: row.callStartedAt,
    seconds: row.callSeconds, contactId: row.contactId || null, contactName: row.contactName || null,
  } : null;
  const recordings = Number(row.recordingCount) || 0;
  const transcribed = Number(row.transcriptCount) || 0;
  const lead = row.leadId ? {
    id: row.leadId, title: row.leadTitle, destination: row.leadDestination,
    status: row.leadStatus, createdAt: row.leadCreatedAt, updatedAt: row.leadUpdatedAt,
    customerEmail: row.leadCustomerEmail, supplierId: row.leadSupplierId, supplierName: row.leadSupplierName,
  } : null;

  const status = lead?.status || (recordings ? 'recorded' : call ? 'called' : 'new');
  const approved = ['approved', 'quote_sent', 'sent_to_customer', 'sent_to_supplier', 'negotiation', 'booked', 'converted'].includes(status);
  const sent = ['quote_sent', 'sent_to_customer', 'sent_to_supplier', 'negotiation', 'booked', 'converted'].includes(status);

  const stations = [
    station('call', call ? ((call.status === 'completed' || recordings > 0 || lead) ? 'done' : 'active') : 'ready', { note: call ? `${call.status}${call.seconds ? ` · ${call.seconds}s` : ''}` : 'nobody has been called yet' }),
    station('recording', recordings ? 'done' : (call ? 'active' : 'waiting'), { note: recordings ? `${recordings} recording${recordings > 1 ? 's' : ''} in the vault` : (call ? 'waiting on Plivo to post the audio' : 'needs a call first') }),
    station('transcription', transcribed ? 'done' : (recordings ? 'active' : 'waiting'), { note: transcribed ? 'transcript on file' : (recordings ? 'audio ready to transcribe' : 'needs a recording') }),
    station('itinerary', lead ? 'done' : (transcribed ? 'active' : 'waiting'), { note: lead ? `${lead.destination || 'trip'} · ${lead.title}` : (transcribed ? 'transcript ready for the designer' : 'needs a transcript') }),
    station('approval', status === 'rejected' ? 'blocked' : approved ? 'done' : (lead ? 'active' : 'waiting'), { note: lead ? (status === 'pending_approval' ? 'waiting for a staff member' : status) : 'nothing to approve yet' }),
    station('despatch', sent ? 'done' : (approved ? 'active' : 'waiting'), { note: sent ? (lead?.supplierName ? `guest + ${lead.supplierName}` : 'guest mailed') : (approved ? 'approved — ready to post' : 'nothing goes out before approval') }),
  ];

  const nextIndex = stations.findIndex(s => s.state !== 'done');
  return {
    id: call?.id || `lead:${lead.id}`,
    callId: call?.id || null,
    leadId: lead?.id || null,
    contact: call?.contactName ? { id: call.contactId, name: call.contactName } : null,
    title: lead?.title || (call ? `Call to ${call.to || call.from}` : 'Lead'),
    destination: lead?.destination || null,
    status,
    statusLabel: status.replace(/_/g, ' '),
    createdAt: lead?.createdAt || call?.startedAt || null,
    updatedAt: lead?.updatedAt || call?.startedAt || null,
    stations,
    next: nextIndex === -1 ? null : stations[nextIndex].key,
    blocked: status === 'rejected',
  };
}

export const pipelineRouter = () => {
  const r = express.Router();

  r.get('/', wrap(async (_req, res) => {
    const organizationId = await orgId();
    const rows = await db.many(`
      SELECT c.id AS "callId", c.status AS "callStatus", c.direction, c."from" AS "callFrom", c."to" AS "callTo",
             c."startedAt" AS "callStartedAt", c."durationSeconds" AS "callSeconds",
             ct.id AS "contactId", ct.name AS "contactName",
             (SELECT count(*)::int FROM recordings g WHERE g."callId" = c.id) AS "recordingCount",
             (SELECT count(*)::int FROM transcriptions t WHERE t."callId" = c.id AND t.text IS NOT NULL) AS "transcriptCount",
             l.id AS "leadId", l.title AS "leadTitle", l.destination AS "leadDestination", l.status AS "leadStatus",
             l."createdAt" AS "leadCreatedAt", l."updatedAt" AS "leadUpdatedAt", l."customerEmail" AS "leadCustomerEmail",
             l."selectedSupplierId" AS "leadSupplierId", s.name AS "leadSupplierName"
      FROM calls c
      LEFT JOIN contacts ct ON ct."organizationId" = c."organizationId" AND (ct.phone = c."from" OR ct.phone = c."to")
      LEFT JOIN LATERAL (
        SELECT * FROM leads x WHERE x."callId" = c.id ORDER BY x."createdAt" DESC LIMIT 1
      ) l ON true
      LEFT JOIN suppliers s ON s.id = l."selectedSupplierId"
      WHERE c."organizationId" = $1
      ORDER BY coalesce(l."updatedAt", c."startedAt") DESC
      LIMIT 60`, [organizationId]);

    const orphanLeads = await db.many(`
      SELECT l.id, l.title, l.destination, l.status, l."createdAt", l."updatedAt", l."customerEmail",
             l."selectedSupplierId", s.name AS "supplierName", ct.id AS "contactId", ct.name AS "contactName",
             (SELECT count(*)::int FROM transcriptions t WHERE t."callId" = l."callId" AND t.text IS NOT NULL) AS "transcriptCount",
             l."callId"
      FROM leads l
      LEFT JOIN suppliers s ON s.id = l."selectedSupplierId"
      LEFT JOIN contacts ct ON ct.id = l."contactId"
      WHERE l."organizationId" = $1 AND l."callId" IS NULL
      ORDER BY l."updatedAt" DESC LIMIT 30`, [organizationId]);

    const cases = [
      ...rows.map(buildCase),
      ...orphanLeads.map(l => buildCase({
        leadId: l.id, leadTitle: l.title, leadDestination: l.destination, leadStatus: l.status,
        leadCreatedAt: l.createdAt, leadUpdatedAt: l.updatedAt,
        leadCustomerEmail: l.customerEmail, leadSupplierId: l.selectedSupplierId,
        leadSupplierName: l.supplierName, transcriptCount: l.transcriptCount,
        contactId: l.contactId, contactName: l.contactName,
      })),
    ].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

    const stationCounts = Object.fromEntries(STATIONS.map(s => [s.key, {
      done: cases.filter(c => c.stations.find(x => x.key === s.key)?.state === 'done').length,
      waiting: cases.filter(c => ['ready', 'active'].includes(c.stations.find(x => x.key === s.key)?.state)).length,
    }]));

    res.json({
      stations: STATIONS,
      cases,
      stationCounts,
      awaitingApproval: cases.filter(c => c.status === 'pending_approval').length,
      inFlight: cases.filter(c => c.next && !c.blocked).length,
    });
  }));

  /** One case in full: the call, its audio, its words, the lead and the trail. */
  r.get('/:id', wrap(async (req, res) => {
    const organizationId = await orgId();
    const id = String(req.params.id);
    if (id.startsWith('lead:')) {
      const leadId = id.slice(5);
      const lead = await db.one('SELECT * FROM leads WHERE id = $1 AND "organizationId" = $2', [leadId, organizationId]);
      if (!lead) return res.status(404).json({ error: 'no such case' });
      const supplier = lead.selectedSupplierId ? await db.one('SELECT * FROM suppliers WHERE id = $1', [lead.selectedSupplierId]) : null;
      const contact = lead.contactId ? await db.one('SELECT * FROM contacts WHERE id = $1', [lead.contactId]) : null;
      return res.json({ case: buildCase({ leadId: lead.id, leadTitle: lead.title, leadDestination: lead.destination, leadStatus: lead.status, leadUpdatedAt: lead.updatedAt, leadCustomerEmail: lead.customerEmail }), lead, supplier, contact, call: null, recordings: [], transcriptions: [] });
    }

    let call = await db.one('SELECT * FROM calls WHERE id = $1 AND "organizationId" = $2', [id, organizationId]);
    if (!call) {
      const lead = await db.one('SELECT * FROM leads WHERE id = $1 AND "organizationId" = $2', [id, organizationId]);
      if (lead) {
        if (lead.callId) {
          call = await db.one('SELECT * FROM calls WHERE id = $1 AND "organizationId" = $2', [lead.callId, organizationId]);
        }
        if (!call) {
          const supplier = lead.selectedSupplierId ? await db.one('SELECT * FROM suppliers WHERE id = $1', [lead.selectedSupplierId]) : null;
          const contact = lead.contactId ? await db.one('SELECT * FROM contacts WHERE id = $1', [lead.contactId]) : null;
          return res.json({ case: buildCase({ leadId: lead.id, leadTitle: lead.title, leadDestination: lead.destination, leadStatus: lead.status, leadUpdatedAt: lead.updatedAt, leadCustomerEmail: lead.customerEmail }), lead, supplier, contact, call: null, recordings: [], transcriptions: [] });
        }
      } else {
        return res.status(404).json({ error: 'no such case' });
      }
    }
    const [recordings, transcriptions, lead, contact] = await Promise.all([
      db.many('SELECT id, status, "durationSeconds", "createdAt" FROM recordings WHERE "callId" = $1 ORDER BY "createdAt"', [call.id]),
      db.many('SELECT id, text, "wordCount", language, source, "recordingId", "createdAt" FROM transcriptions WHERE "callId" = $1 ORDER BY "createdAt" DESC', [call.id]),
      db.one('SELECT * FROM leads WHERE "callId" = $1 ORDER BY "createdAt" DESC LIMIT 1', [call.id]),
      db.one('SELECT * FROM contacts WHERE "organizationId" = $1 AND (phone = $2 OR phone = $3) LIMIT 1', [organizationId, call.from, call.to]),
    ]);
    const audio = recordings.map(r => ({ ...r, playUrl: signedMediaUrl(r.id) }));
    res.json({
      case: buildCase({
        callId: call.id, callStatus: call.status, direction: call.direction, callFrom: call.from, callTo: call.to,
        callStartedAt: call.startedAt, callSeconds: call.durationSeconds,
        contactId: contact?.id, contactName: contact?.name,
        recordingCount: recordings.length, transcriptCount: transcriptions.filter(t => t.text).length,
        leadId: lead?.id, leadTitle: lead?.title, leadDestination: lead?.destination, leadStatus: lead?.status,
        leadUpdatedAt: lead?.updatedAt, leadSupplierId: lead?.selectedSupplierId,
      }),
      call, recordings: audio, transcriptions, lead, contact,
    });
  }));

  return r;
};
