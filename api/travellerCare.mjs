// Module 8: Traveller Care API (Visa, Pre-departure, Feedback, Repeat Marketing — Slide 11)
import express from 'express';
import { db, orgId, newId } from '../db/index.mjs';
import { wrap, fail, requireId, text } from './http.mjs';
import { logAudit } from '../lib/audit.mjs';
import { bus } from '../lib/events.mjs';
import { sendWhatsAppMessage } from '../lib/whatsapp.mjs';

export const travellerCareRouter = () => {
  const r = express.Router();

  /** Get visa checklist for a lead or booking */
  r.get('/visa', wrap(async (req, res) => {
    const organizationId = await orgId();
    const leadId = req.query.leadId ? text(req.query.leadId) : null;
    const bookingId = req.query.bookingId ? text(req.query.bookingId) : null;

    const where = ['v."organizationId" = $1'];
    const params = [organizationId];

    if (leadId) { params.push(leadId); where.push(`v."leadId" = $${params.length}`); }
    if (bookingId) { params.push(bookingId); where.push(`v."bookingId" = $${params.length}`); }

    const docs = await db.many(`
      SELECT v.*, l.destination, l.title AS "leadTitle"
      FROM visa_checklists v
      JOIN leads l ON l.id = v."leadId"
      WHERE ${where.join(' AND ')}
      ORDER BY v."createdAt" ASC
    `, params);

    res.json({ docs });
  }));

  /** Update status of a visa checklist document (e.g. verified, submitted, rejected) */
  r.post('/visa/:id/verify', wrap(async (req, res) => {
    const organizationId = await orgId();
    const docId = requireId(req.params.id, 'doc id');
    const status = text(req.body?.status, { max: 30 }) || 'verified';
    const notes = text(req.body?.notes, { max: 1000 });

    const updated = await db.one(`
      UPDATE visa_checklists
      SET status = $2, notes = coalesce($3, notes), "updatedAt" = now()
      WHERE id = $1 AND "organizationId" = $4
      RETURNING *
    `, [docId, status, notes, organizationId]);
    if (!updated) throw fail(404, 'visa document not found');

    bus.broadcast('visa.verified', { organizationId, docId, status });
    res.json({ ok: true, doc: updated });
  }));

  /** List all traveller care records (Pre-departure packs, Post-trip feedback, Repeat marketing) */
  r.get('/items', wrap(async (req, res) => {
    const organizationId = await orgId();
    const type = req.query.type ? text(req.query.type) : null;

    const where = ['c."organizationId" = $1'];
    const params = [organizationId];

    if (type) { params.push(type); where.push(`c.type = $${params.length}`); }

    const items = await db.many(`
      SELECT c.*, l.title AS "leadTitle", l.destination, ct.name AS "contactName", ct.phone, ct.email
      FROM traveller_care c
      JOIN leads l ON l.id = c."leadId"
      LEFT JOIN contacts ct ON ct.id = l."contactId"
      WHERE ${where.join(' AND ')}
      ORDER BY c."scheduledFor" ASC
      LIMIT 100
    `, params);

    res.json({ items });
  }));

  /** Submit post-trip feedback review (Module 8: Step 5) */
  r.post('/feedback/:id/submit', wrap(async (req, res) => {
    const organizationId = await orgId();
    const feedbackId = requireId(req.params.id, 'feedback id');
    const rating = Math.min(5, Math.max(1, Number(req.body?.rating) || 5));
    const feedbackText = text(req.body?.feedbackText, { max: 4000 }) || 'Wonderful experience organized by the holiday desk!';

    const updated = await db.one(`
      UPDATE traveller_care
      SET status = 'received', rating = $2, "feedbackText" = $3, "sentAt" = now(), "updatedAt" = now()
      WHERE id = $1 AND "organizationId" = $4
      RETURNING *
    `, [feedbackId, rating, feedbackText, organizationId]);
    if (!updated) throw fail(404, 'feedback item not found');

    bus.broadcast('feedback.received', { organizationId, feedbackId, rating });
    res.json({ ok: true, feedback: updated });
  }));

  /** Trigger a repeat marketing campaign to past customers (Module 8: Step 6) */
  r.post('/repeat-marketing', wrap(async (req, res) => {
    const organizationId = await orgId();
    const offerTitle = text(req.body?.title, { max: 200 }) || 'Exclusive Autumn Escape: Bali & Maldives Early Bird';
    const message = text(req.body?.message, { max: 2000 }) || 'Exclusive early-bird offer for our valued travelers. Book your next private getaway with customized upgrades.';

    // Pull past customers with completed trips
    const pastTravellers = await db.many(`
      SELECT DISTINCT ct.id, ct.name, ct.phone, ct.email
      FROM contacts ct
      JOIN leads l ON l."contactId" = ct.id
      WHERE ct."organizationId" = $1 AND l.status IN ('booked', 'converted')
      LIMIT 50
    `, [organizationId]);

    let sent = 0;
    for (const traveler of pastTravellers) {
      if (traveler.phone) {
        await sendWhatsAppMessage({
          organizationId,
          to: traveler.phone,
          text: `Hello ${traveler.name}!\n\n${offerTitle}\n\n${message}\n\nReply directly to book with your loyalty benefits!`,
          templateKey: 'repeat_marketing_campaign',
        });
        sent++;
      }
    }

    await logAudit({
      action: 'campaign.repeat_marketing',
      targetType: 'Marketing',
      targetId: newId(),
      metadata: { offerTitle, recipientsCount: sent },
    });

    res.json({ ok: true, sentCount: sent, offerTitle });
  }));

  return r;
};

