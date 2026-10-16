// Trip design desk — transcript in, itinerary + flights + pricing out, approval gate, multi-channel despatch.
import express from 'express';
import { db, orgId, newId } from '../db/index.mjs';
import { wrap, fail, requireId, text, emailAddress, bool } from './http.mjs';
import { logAudit } from '../lib/audit.mjs';
import { generateItineraryFromTranscript, reviseItinerary, itineraryConfigured } from '../lib/itinerary.mjs';
import { generateItineraryPDF } from '../lib/pdf.mjs';
import { sendCustomerItinerary, sendSupplierRfq, mailConfigured } from '../lib/mail.mjs';
import { sendWhatsAppMessage, formatQuotationWhatsApp, whatsappConfigured } from '../lib/whatsapp.mjs';
import { searchFlights, normalizeFlightSegment } from '../lib/flights.mjs';
import { bus } from '../lib/events.mjs';

const OPEN = ['new', 'contacted', 'qualified', 'draft', 'pending_approval'];
export const LEAD_STATUSES = [
  'new', 'contacted', 'qualified', 'draft', 'pending_approval', 'approved',
  'quote_sent', 'sent_to_customer', 'sent_to_supplier', 'negotiation', 'booked', 'converted', 'lost', 'rejected',
];

const LEAD_SELECT = `
  SELECT l.*, ct.name AS "contactName", ct.phone AS "contactPhone", ct.email AS "contactEmail",
         s.name AS "supplierName", s.email AS "supplierEmail",
         c.direction, c."from" AS "callFrom", c."to" AS "callTo", c."startedAt" AS "callStartedAt", c."durationSeconds" AS "callSeconds",
         (SELECT count(*)::int FROM recordings g WHERE g."callId" = l."callId") AS "recordingCount",
         (SELECT count(*)::int FROM transcriptions t WHERE t."callId" = l."callId" AND t.text IS NOT NULL) AS "transcriptCount",
         (SELECT count(*)::int FROM supplier_quotes sq WHERE sq."leadId" = l.id) AS "supplierQuotesCount",
         (SELECT count(*)::int FROM lead_versions lv WHERE lv."leadId" = l.id) AS "versionsCount"
  FROM leads l
  LEFT JOIN contacts ct ON ct.id = l."contactId"
  LEFT JOIN suppliers s ON s.id = l."selectedSupplierId"
  LEFT JOIN calls c ON c.id = l."callId"`;

export const leadsRouter = () => {
  const r = express.Router();

  r.get('/statuses', (_req, res) => res.json({ statuses: LEAD_STATUSES }));

  /** Search flight options for an inquiry */
  r.get('/flights/search', wrap(async (req, res) => {
    const { from, to, date, pax, cabinClass } = req.query;
    const flights = await searchFlights({
      from: text(from) || 'DEL',
      to: text(to) || 'DXB',
      date: text(date),
      passengers: Number(pax) || 2,
      cabinClass: text(cabinClass) || 'Economy',
    });
    res.json({ flights });
  }));

  r.get('/', wrap(async (req, res) => {
    const organizationId = await orgId();
    const params = [organizationId];
    const where = ['l."organizationId" = $1'];
    if (req.query.status) {
      const list = String(req.query.status).split(',').map(s => s.trim()).filter(Boolean);
      params.push(list);
      where.push(`l.status = ANY($${params.length})`);
    }
    if (req.query.awaiting === 'true') where.push(`l.status = 'pending_approval'`);
    if (req.query.search) {
      params.push(`%${String(req.query.search).trim()}%`);
      where.push(`(l.title ILIKE $${params.length} OR coalesce(l.destination,'') ILIKE $${params.length} OR coalesce(ct.name,'') ILIKE $${params.length})`);
    }
    const leads = await db.many(`${LEAD_SELECT} WHERE ${where.join(' AND ')} ORDER BY l."updatedAt" DESC LIMIT ${Math.min(300, Number(req.query.limit) || 100)}`, params);

    const counts = await db.many('SELECT status, count(*)::int AS n FROM leads WHERE "organizationId" = $1 GROUP BY status', [organizationId]);
    res.json({
      leads,
      counts: Object.fromEntries(counts.map(c => [c.status, c.n])),
      awaitingApproval: counts.find(c => c.status === 'pending_approval')?.n || 0,
      providers: { itinerary: itineraryConfigured(), mail: mailConfigured(), whatsapp: whatsappConfigured() },
    });
  }));

  r.get('/:id', wrap(async (req, res) => {
    const lead = await load(req.params.id);
    const [recordings, transcriptions, quotes, versions, events] = await Promise.all([
      lead.callId ? db.many('SELECT id, "durationSeconds", status, "createdAt" FROM recordings WHERE "callId" = $1 ORDER BY "createdAt"', [lead.callId]) : [],
      lead.callId ? db.many('SELECT id, "wordCount", language, text, source, "createdAt" FROM transcriptions WHERE "callId" = $1 AND text IS NOT NULL ORDER BY "createdAt" DESC', [lead.callId]) : [],
      db.many('SELECT q.*, s.name AS "supplierName" FROM supplier_quotes q LEFT JOIN suppliers s ON s.id = q."supplierId" WHERE q."leadId" = $1 ORDER BY q."quoteAmount" ASC', [lead.id]),
      db.many('SELECT id, "versionNumber", title, notes, author, "createdAt" FROM lead_versions WHERE "leadId" = $1 ORDER BY "versionNumber" DESC', [lead.id]),
      db.many(`SELECT id, action, metadata, result, "createdAt" FROM audit_logs
               WHERE "organizationId" = $1 AND "targetId" = $2 ORDER BY "createdAt" DESC LIMIT 40`, [lead.organizationId, lead.id]),
    ]);
    res.json({ lead, recordings, transcriptions, quotes, versions, trail: events });
  }));

  /** Create lead manually */
  r.post('/', wrap(async (req, res) => {
    const organizationId = await orgId();
    const body = req.body || {};
    const title = text(body.title, { required: true, field: 'title', max: 250 });
    const itinerary = text(body.itinerary, { max: 60000 }) || `# ${title}\n\n(no itinerary written yet)`;
    const contactId = text(body.contactId, { max: 60 });
    if (contactId) {
      const contact = await db.one('SELECT id FROM contacts WHERE id = $1 AND "organizationId" = $2', [contactId, organizationId]);
      if (!contact) throw fail(404, 'no such contact');
    }
    const lead = await db.one(`
      INSERT INTO leads (id,"organizationId","contactId",title,destination,status,itinerary,"customerEmail",flights,pricing,qualification,"updatedAt")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now()) RETURNING *`,
      [newId(), organizationId, contactId, title, text(body.destination, { max: 250 }),
       OPEN.includes(body.status) ? body.status : 'pending_approval',
       itinerary, emailAddress(body.customerEmail, { field: 'customer email' }),
       JSON.stringify(body.flights || []), JSON.stringify(body.pricing || {}),
       JSON.stringify(body.qualification || {})]);

    await logAudit({ action: 'lead.create', targetType: 'Lead', targetId: lead.id, metadata: { title } });
    bus.broadcast('lead.created', { organizationId, leadId: lead.id, title });
    res.status(201).json({ lead });
  }));

  /** Generate itinerary and auto-qualification from transcript */
  r.post('/generate', wrap(async (req, res) => {
    const organizationId = await orgId();
    const body = req.body || {};
    const callId = text(body.callId, { max: 60 });
    const transcriptionId = text(body.transcriptionId, { max: 60 });
    if (!callId && !transcriptionId) throw fail(400, 'give the designer a callId or a transcriptionId');

    let call = null;
    let transcription = null;
    if (transcriptionId) {
      transcription = await db.one('SELECT * FROM transcriptions WHERE id = $1 AND "organizationId" = $2', [transcriptionId, organizationId]);
      if (!transcription) throw fail(404, 'no such transcription');
      if (transcription.callId) call = await db.one('SELECT * FROM calls WHERE id = $1', [transcription.callId]);
    } else {
      call = await db.one('SELECT * FROM calls WHERE id = $1 AND "organizationId" = $2', [callId, organizationId]);
      if (!call) throw fail(404, 'no such call');
      transcription = await db.one(
        `SELECT * FROM transcriptions WHERE "callId" = $1 AND text IS NOT NULL AND length(btrim(text)) > 1
         ORDER BY "createdAt" DESC LIMIT 1`, [call.id]);
    }

    const targetPhone = call ? (call.direction === 'outbound' ? call.to : call.from) : null;
    const contact = targetPhone
      ? await db.one(`SELECT * FROM contacts WHERE "organizationId" = $1 AND phone IN ($2, $3) LIMIT 1`,
        [organizationId, targetPhone, targetPhone.replace(/\D/g, '')])
      : null;

    const transcriptText = transcription?.text?.trim()
      || `Travel consultation call${targetPhone ? ` with ${targetPhone}` : ''}. Duration ${call?.durationSeconds || 45} seconds. The client wants a vacation package with flights, accommodation and guided excursions.`;

    const result = await generateItineraryFromTranscript(transcriptText, {
      name: contact?.name || 'Valued Client',
      phone: targetPhone,
      company: contact?.company,
    });

    const qualification = result.qualification || {
      estimatedBudget: 'On Request', travelDates: 'Upcoming', numberOfTravelers: 2, travelStyle: 'Bespoke Luxury',
    };

    const existing = call ? await db.one('SELECT * FROM leads WHERE "callId" = $1 ORDER BY "createdAt" DESC LIMIT 1', [call.id]) : null;
    const lead = existing
      ? await db.one(`
          UPDATE leads SET title=$2, destination=$3, itinerary=$4, qualification=$5, status='pending_approval',
            "customerEmail"=coalesce("customerEmail",$6), "contactId"=coalesce("contactId",$7), "currentVersion"=1, "updatedAt"=now()
          WHERE id=$1 RETURNING *`,
        [existing.id, result.title, result.destination, result.itinerary, JSON.stringify(qualification),
         contact?.email || null, contact?.id || null])
      : await db.one(`
          INSERT INTO leads (id,"organizationId","contactId","callId",title,destination,status,itinerary,qualification,"customerEmail","currentVersion","updatedAt")
          VALUES ($1,$2,$3,$4,$5,$6,'pending_approval',$7,$8,$9,1, now()) RETURNING *`,
        [newId(), organizationId, contact?.id || null, call?.id || null, result.title, result.destination, result.itinerary, JSON.stringify(qualification), contact?.email || null]);

    // Create initial v1 snapshot in lead_versions
    await db.query(`
      INSERT INTO lead_versions (id, "organizationId", "leadId", "versionNumber", title, destination, itinerary, flights, pricing, notes, author)
      VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, 'AI Designer')
      ON CONFLICT DO NOTHING
    `, [newId(), organizationId, lead.id, lead.title, lead.destination, lead.itinerary, JSON.stringify(lead.flights || []), JSON.stringify(lead.pricing || {}), 'Initial itinerary generated from call']);

    await logAudit({
      action: 'lead.generate_itinerary', targetType: 'Lead', targetId: lead.id,
      metadata: { callId: call?.id || null, title: result.title, destination: result.destination, provider: result.provider, model: result.model },
    });

    bus.broadcast('lead.qualified', { organizationId, leadId: lead.id, qualification });

    res.status(201).json({ lead, qualification, provider: result.provider, model: result.model, transcriptCharacters: transcriptText.length });
  }));

  /** Update lead fields (flights, pricing, qualification, status, lostReason) */
  r.put('/:id', wrap(async (req, res) => {
    const lead = await load(req.params.id);
    const body = req.body || {};

    const flights = body.flights ? JSON.stringify(Array.isArray(body.flights) ? body.flights.map(normalizeFlightSegment) : body.flights) : undefined;
    const pricing = body.pricing ? JSON.stringify(body.pricing) : undefined;
    const qualification = body.qualification ? JSON.stringify(body.qualification) : undefined;
    const lostReason = body.lostReason !== undefined ? text(body.lostReason, { max: 1000 }) : undefined;
    const newStatus = body.status && LEAD_STATUSES.includes(body.status) ? body.status : undefined;

    const updated = await db.one(`
      UPDATE leads SET
        title = coalesce($2, title),
        destination = coalesce($3, destination),
        itinerary = coalesce($4, itinerary),
        "customerEmail" = coalesce($5, "customerEmail"),
        "selectedSupplierId" = coalesce($6, "selectedSupplierId"),
        flights = coalesce($7::jsonb, flights),
        pricing = coalesce($8::jsonb, pricing),
        qualification = coalesce($9::jsonb, qualification),
        "lostReason" = coalesce($10, "lostReason"),
        status = coalesce($11, status),
        "updatedAt" = now()
      WHERE id = $1 RETURNING *`,
      [lead.id,
       text(body.title, { max: 250 }),
       text(body.destination, { max: 250 }),
       text(body.itinerary, { max: 60000 }),
       emailAddress(body.customerEmail, { field: 'customer email' }),
       text(body.supplierId, { max: 60 }),
       flights, pricing, qualification, lostReason, newStatus]);

    await logAudit({ action: 'lead.update', targetType: 'Lead', targetId: lead.id, metadata: { status: updated.status } });
    if (newStatus && newStatus !== lead.status) {
      bus.broadcast('lead.status_changed', { organizationId: lead.organizationId, leadId: lead.id, oldStatus: lead.status, newStatus });
    }
    res.json({ lead: updated });
  }));

  /** Staff approval gate */
  r.post('/:id/approve', wrap(async (req, res) => {
    const lead = await load(req.params.id);
    if (!OPEN.includes(lead.status)) {
      return res.json({ lead, note: `already ${lead.status} — nothing to approve` });
    }
    const updated = await db.one(
      `UPDATE leads SET status='approved', "updatedAt"=now() WHERE id=$1 RETURNING *`, [lead.id]);
    await logAudit({
      action: 'lead.approve', targetType: 'Lead', targetId: lead.id,
      metadata: { approvedBy: text((req.body || {}).by, { max: 120 }) || 'Holiday desk', title: lead.title },
    });
    res.json({ lead: updated });
  }));

  /** Revise itinerary with snapshot versioning (Module 3) */
  r.post('/:id/revise', wrap(async (req, res) => {
    const lead = await load(req.params.id);
    const notes = text((req.body || {}).correctionNotes ?? (req.body || {}).notes, { required: true, field: 'notes', max: 4000 });
    const revised = await reviseItinerary(lead.itinerary, notes);
    const nextVersion = (lead.currentVersion || 1) + 1;

    const updated = await db.one(`
      UPDATE leads SET itinerary=$2, "revisionNotes"=$3, "currentVersion"=$4, status='pending_approval', "updatedAt"=now()
      WHERE id=$1 RETURNING *`, [lead.id, revised.itinerary, notes, nextVersion]);

    // Create version snapshot in lead_versions
    await db.query(`
      INSERT INTO lead_versions (id, "organizationId", "leadId", "versionNumber", title, destination, itinerary, flights, pricing, notes, author)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [newId(), lead.organizationId, lead.id, nextVersion, updated.title, updated.destination, updated.itinerary,
        JSON.stringify(updated.flights || []), JSON.stringify(updated.pricing || {}), notes, text((req.body || {}).author, { max: 100 }) || 'Staff']);

    await logAudit({
      action: 'lead.revise', targetType: 'Lead', targetId: lead.id,
      metadata: { version: nextVersion, notes, provider: revised.provider, model: revised.model },
    });

    bus.broadcast('lead.revised', { organizationId: lead.organizationId, leadId: lead.id, version: nextVersion });

    res.json({ lead: updated, version: nextVersion, provider: revised.provider, model: revised.model });
  }));

  r.post('/:id/reject', wrap(async (req, res) => {
    const lead = await load(req.params.id);
    const reason = text((req.body || {}).reason ?? (req.body || {}).notes, { max: 2000 });
    const updated = await db.one(
      `UPDATE leads SET status='rejected', "lostReason"=coalesce($2,"lostReason"), "updatedAt"=now() WHERE id=$1 RETURNING *`,
      [lead.id, reason]);
    await logAudit({ action: 'lead.reject', targetType: 'Lead', targetId: lead.id, metadata: { reason } });
    bus.broadcast('lead.status_changed', { organizationId: lead.organizationId, leadId: lead.id, oldStatus: lead.status, newStatus: 'rejected', reason });
    res.json({ lead: updated });
  }));

  r.get('/:id/pdf', wrap(async (req, res) => {
    const lead = await load(req.params.id);
    const kind = req.query.type === 'supplier' ? 'supplier' : 'customer';
    const organization = await db.one('SELECT name FROM organizations WHERE id = $1', [lead.organizationId]);
    const contact = lead.contactId ? await db.one('SELECT * FROM contacts WHERE id = $1', [lead.contactId]) : null;
    const supplier = lead.selectedSupplierId ? await db.one('SELECT * FROM suppliers WHERE id = $1', [lead.selectedSupplierId]) : null;

    const pdf = await generateItineraryPDF({
      title: kind === 'supplier' ? `Quotation Request: ${lead.title}` : lead.title,
      recipientName: kind === 'supplier'
        ? `${supplier?.name || 'Supplier'} (${supplier?.contactPerson || 'Reservations'})`
        : contact?.name || 'Valued Client',
      recipientEmail: kind === 'supplier' ? supplier?.email : (lead.customerEmail || contact?.email),
      recipientType: kind,
      itineraryText: lead.itinerary,
      flights: lead.flights || [],
      pricing: lead.pricing || {},
      organizationName: organization?.name,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${kind}-${lead.id.slice(0, 8)}.pdf"`);
    res.end(Buffer.from(pdf));
  }));

  /** Send quotation via Email & WhatsApp (Slide 7, 9) */
  r.post('/:id/send', wrap(async (req, res) => {
    const lead = await load(req.params.id);
    const body = req.body || {};
    if (lead.status === 'rejected') throw fail(400, 'this lead was rejected — reopen it before sending');

    const contact = lead.contactId ? await db.one('SELECT * FROM contacts WHERE id = $1', [lead.contactId]) : null;
    let toEmail = emailAddress(body.customerEmail, { field: 'customer email' }) || lead.customerEmail || contact?.email || null;
    let toPhone = text(body.customerPhone, { max: 40 }) || contact?.phone || null;

    if (!toEmail && lead.callId) {
      const call = await db.one('SELECT * FROM calls WHERE id = $1', [lead.callId]);
      const counterpart = call ? (call.direction === 'outbound' ? call.to : call.from) : null;
      if (counterpart) {
        if (!toPhone) toPhone = counterpart;
        const matched = await db.one(
          `SELECT email FROM contacts WHERE "organizationId" = $1 AND phone IN ($2,$3) AND email IS NOT NULL LIMIT 1`,
          [lead.organizationId, counterpart, counterpart.replace(/\D/g, '')]);
        toEmail = matched?.email || null;
      }
    }

    const supplierId = text(body.supplierId, { max: 60 }) || lead.selectedSupplierId;
    const supplier = supplierId
      ? await db.one('SELECT * FROM suppliers WHERE id = $1 AND "organizationId" = $2', [supplierId, lead.organizationId])
      : null;

    const organization = await db.one('SELECT name FROM organizations WHERE id = $1', [lead.organizationId]);
    const customerName = contact?.name || 'Valued Client';

    // 1. Generate final customer quotation PDF
    const customerPdf = await generateItineraryPDF({
      title: lead.title, recipientName: customerName, recipientEmail: toEmail || undefined,
      recipientType: 'customer', itineraryText: lead.itinerary, flights: lead.flights || [],
      pricing: lead.pricing || {}, organizationName: organization?.name,
    });

    // 2. Email dispatch
    let customerMail = { success: false, simulated: false };
    if (toEmail) {
      customerMail = await sendCustomerItinerary({
        to: toEmail, customerName, title: lead.title, destination: lead.destination || 'Bespoke Travel', pdfBuffer: customerPdf,
      });
    }

    // 3. WhatsApp dispatch
    let customerWhatsApp = { success: false };
    if (toPhone) {
      const waText = formatQuotationWhatsApp({
        customerName,
        title: lead.title,
        destination: lead.destination || 'Bespoke Vacation',
        finalPrice: lead.pricing?.finalSellingPrice,
        currency: lead.pricing?.currency || 'INR',
      });
      customerWhatsApp = await sendWhatsAppMessage({
        organizationId: lead.organizationId,
        to: toPhone,
        text: waText,
        templateKey: 'final_quotation_v1',
      });
    }

    // 4. Supplier RFQ email dispatch
    let supplierMail = null;
    if (supplier) {
      const supplierPdf = await generateItineraryPDF({
        title: `Quotation Request: ${lead.title}`,
        recipientName: `${supplier.name} (${supplier.contactPerson || 'Reservations'})`,
        recipientEmail: supplier.email, recipientType: 'supplier',
        itineraryText: lead.itinerary, organizationName: organization?.name,
      });
      supplierMail = await sendSupplierRfq({
        to: supplier.email, supplierName: supplier.name, contactPerson: supplier.contactPerson || undefined,
        customerName, title: lead.title, destination: lead.destination || 'Bespoke Travel', pdfBuffer: supplierPdf,
      });
    }

    // Update lead record
    const updated = await db.one(`
      UPDATE leads SET status='quote_sent', "customerEmail"=coalesce($2,"customerEmail"),
        "customerSentAt"=now(), "quotationSentAt"=now(),
        "supplierSentAt"=CASE WHEN $3::text IS NULL THEN "supplierSentAt" ELSE now() END,
        "selectedSupplierId"=coalesce($3,"selectedSupplierId"), "updatedAt"=now()
      WHERE id=$1 RETURNING *`,
      [lead.id, toEmail, supplier?.id || null]);

    await logAudit({
      action: 'lead.send_quotation', targetType: 'Lead', targetId: lead.id,
      result: (customerMail.success || customerWhatsApp.success) ? 'success' : 'partial',
      metadata: {
        toEmail, emailSuccess: customerMail.success,
        toPhone, whatsappSuccess: customerWhatsApp.success,
        supplierId: supplier?.id, supplierSuccess: supplierMail?.success,
      },
    });

    // 5. Broadcast quotation.sent event (triggers Follow-up automations!)
    bus.broadcast('quotation.sent', {
      organizationId: lead.organizationId,
      leadId: lead.id,
      phone: toPhone,
      email: toEmail,
      customerName,
      title: lead.title,
      destination: lead.destination,
      pricing: lead.pricing,
    });

    res.json({
      lead: updated,
      email: { to: toEmail, sent: !!customerMail.success, simulated: !!customerMail.simulated },
      whatsapp: { to: toPhone, sent: !!customerWhatsApp.success, provider: customerWhatsApp.provider },
      supplier: supplier ? { to: supplier.email, sent: !!supplierMail?.success } : null,
    });
  }));

  r.delete('/:id', wrap(async (req, res) => {
    const lead = await db.one('DELETE FROM leads WHERE id = $1 AND "organizationId" = $2 RETURNING id, title', [requireId(req.params.id, 'lead id'), await orgId()]);
    if (!lead) throw fail(404, 'no such lead');
    await logAudit({ action: 'lead.delete', targetType: 'Lead', targetId: lead.id, metadata: { title: lead.title } });
    res.json({ ok: true });
  }));

  return r;
};

async function load(id) {
  const lead = await db.one(`${LEAD_SELECT} WHERE l.id = $1 AND l."organizationId" = $2`, [requireId(id, 'lead id'), await orgId()]);
  if (!lead) throw fail(404, 'no such lead');
  return lead;
}
