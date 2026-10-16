// Module 7: Booking & Payments Handover API (Slide 11)
import express from 'express';
import { db, orgId, newId } from '../db/index.mjs';
import { wrap, fail, requireId, text } from './http.mjs';
import { logAudit } from '../lib/audit.mjs';
import { bus } from '../lib/events.mjs';
import { sendWhatsAppMessage } from '../lib/whatsapp.mjs';

export const bookingsRouter = () => {
  const r = express.Router();

  /** List all confirmed bookings */
  r.get('/', wrap(async (req, res) => {
    const organizationId = await orgId();
    const bookings = await db.many(`
      SELECT b.*, l.title AS "leadTitle", l.destination AS "leadDestination",
             c.name AS "contactName", c.phone AS "contactPhone", c.email AS "contactEmail",
             (SELECT count(*)::int FROM payment_schedules p WHERE p."bookingId" = b.id AND p.status = 'pending') AS "pendingPaymentsCount",
             (SELECT count(*)::int FROM visa_checklists v WHERE v."bookingId" = b.id AND v.status = 'required') AS "missingVisaDocsCount"
      FROM bookings b
      JOIN leads l ON l.id = b."leadId"
      LEFT JOIN contacts c ON c.id = b."contactId"
      WHERE b."organizationId" = $1
      ORDER BY b."createdAt" DESC
      LIMIT 100
    `, [organizationId]);

    res.json({ bookings });
  }));

  /** Create booking handover from a lead */
  r.post('/', wrap(async (req, res) => {
    const organizationId = await orgId();
    const body = req.body || {};
    const leadId = requireId(body.leadId, 'leadId');

    const lead = await db.one('SELECT * FROM leads WHERE id = $1 AND "organizationId" = $2', [leadId, organizationId]);
    if (!lead) throw fail(404, 'no such lead');

    const ref = `BK-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const pricing = lead.pricing || {};
    const totalAmount = Number(body.totalAmount ?? pricing.finalSellingPrice ?? 85000);
    const currency = body.currency || pricing.currency || 'INR';

    const bookingId = newId();
    const startDate = body.startDate ? new Date(body.startDate) : new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const endDate = body.endDate ? new Date(body.endDate) : new Date(Date.now() + 37 * 24 * 3600 * 1000);

    const booking = await db.one(`
      INSERT INTO bookings (
        id, "organizationId", "leadId", "contactId", "bookingReference", status,
        "totalAmount", currency, "paidAmount", "startDate", "endDate", "handoverNotes", "createdAt", "updatedAt"
      ) VALUES ($1, $2, $3, $4, $5, 'confirmed', $6, $7, 0, $8, $9, $10, now(), now())
      RETURNING *
    `, [
      bookingId, organizationId, lead.id, lead.contactId, ref, totalAmount, currency,
      startDate, endDate, text(body.notes, { max: 4000 }) || 'Sales to operations booking handover',
    ]);

    // Create 3 standard payment milestones:
    // 1. Advance Deposit (30% Due Now)
    // 2. Second Instalment (50% Due 15 days before travel)
    // 3. Final Balance (20% Due 5 days before travel)
    const p1 = Math.round(totalAmount * 0.3);
    const p2 = Math.round(totalAmount * 0.5);
    const p3 = totalAmount - p1 - p2;

    const milestones = [
      { title: 'Initial Booking Deposit (30%)', amount: p1, due: new Date(Date.now() + 2 * 24 * 3600 * 1000) },
      { title: 'Pre-Travel Instalment (50%)', amount: p2, due: new Date(startDate.getTime() - 15 * 24 * 3600 * 1000) },
      { title: 'Final Balance Payment (20%)', amount: p3, due: new Date(startDate.getTime() - 5 * 24 * 3600 * 1000) },
    ];

    for (const m of milestones) {
      await db.query(`
        INSERT INTO payment_schedules (
          id, "organizationId", "bookingId", "leadId", title, amount, "dueDate", status, "createdAt", "updatedAt"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', now(), now())
      `, [newId(), organizationId, booking.id, lead.id, m.title, m.amount, m.due]);
    }

    // Auto-create destination visa checklist items (Module 8)
    const visaDocs = ['Valid Passport (Min 6 Months Validity)', 'Passport Size Photographs (White Background)', 'Recent 6 Months Bank Statement', 'Travel & Medical Insurance Copy'];
    for (const docName of visaDocs) {
      await db.query(`
        INSERT INTO visa_checklists (
          id, "organizationId", "leadId", "bookingId", destination, "documentName", status, "createdAt", "updatedAt"
        ) VALUES ($1, $2, $3, $4, $5, $6, 'required', now(), now())
      `, [newId(), organizationId, lead.id, booking.id, lead.destination || 'International', docName]);
    }

    // Auto-schedule Traveller Care (Module 8): Pre-departure (3 days before trip) and Feedback (2 days after return)
    const preDepartureDate = new Date(startDate.getTime() - 3 * 24 * 3600 * 1000);
    const feedbackDate = new Date(endDate.getTime() + 2 * 24 * 3600 * 1000);

    await db.query(`
      INSERT INTO traveller_care (id, "organizationId", "leadId", "bookingId", type, status, "scheduledFor", notes, "createdAt", "updatedAt")
      VALUES
        ($1, $2, $3, $4, 'pre_departure', 'pending', $5, 'Vouchers, emergency contacts, local tips pack', now(), now()),
        ($6, $2, $3, $4, 'feedback', 'pending', $7, 'Post-trip satisfaction survey & review request', now(), now())
    `, [newId(), organizationId, lead.id, booking.id, preDepartureDate, newId(), feedbackDate]);

    // Update lead status to 'booked'
    await db.query(`UPDATE leads SET status = 'booked', "updatedAt" = now() WHERE id = $1`, [lead.id]);

    await logAudit({
      action: 'booking.create',
      targetType: 'Booking',
      targetId: booking.id,
      metadata: { bookingReference: ref, leadId: lead.id, totalAmount, currency },
    });

    bus.broadcast('booking.created', { organizationId, bookingId: booking.id, leadId: lead.id, bookingReference: ref, totalAmount });

    res.status(201).json({ booking, reference: ref });
  }));

  /** Get complete booking details with payments, visa, and care records */
  r.get('/:id', wrap(async (req, res) => {
    const organizationId = await orgId();
    const booking = await db.one(`
      SELECT b.*, l.title AS "leadTitle", l.destination AS "leadDestination", l.itinerary,
             c.name AS "contactName", c.phone AS "contactPhone", c.email AS "contactEmail"
      FROM bookings b
      JOIN leads l ON l.id = b."leadId"
      LEFT JOIN contacts c ON c.id = b."contactId"
      WHERE b.id = $1 AND b."organizationId" = $2
    `, [req.params.id, organizationId]);
    if (!booking) throw fail(404, 'no such booking');

    const [payments, visaDocs, careItems] = await Promise.all([
      db.many('SELECT * FROM payment_schedules WHERE "bookingId" = $1 ORDER BY "dueDate" ASC', [booking.id]),
      db.many('SELECT * FROM visa_checklists WHERE "bookingId" = $1 ORDER BY "createdAt" ASC', [booking.id]),
      db.many('SELECT * FROM traveller_care WHERE "bookingId" = $1 ORDER BY "scheduledFor" ASC', [booking.id]),
    ]);

    res.json({ booking, payments, visaDocs, careItems });
  }));

  /** Record a payment installment */
  r.post('/:id/payments/:paymentId/pay', wrap(async (req, res) => {
    const organizationId = await orgId();
    const { paymentId, id: bookingId } = req.params;
    const body = req.body || {};

    const payment = await db.one('SELECT * FROM payment_schedules WHERE id = $1 AND "bookingId" = $2 AND "organizationId" = $3', [paymentId, bookingId, organizationId]);
    if (!payment) throw fail(404, 'payment milestone not found');

    const method = text(body.paymentMethod, { max: 40 }) || 'Bank Transfer';
    const txnRef = text(body.transactionRef, { max: 100 }) || `TXN-${Date.now()}`;

    await db.query(`
      UPDATE payment_schedules
      SET status = 'paid', "paidAt" = now(), "paymentMethod" = $2, "transactionRef" = $3, "updatedAt" = now()
      WHERE id = $1
    `, [payment.id, method, txnRef]);

    // Update total paid on booking
    const sumResult = await db.one(`
      SELECT coalesce(sum(amount), 0)::numeric AS "totalPaid"
      FROM payment_schedules
      WHERE "bookingId" = $1 AND status = 'paid'
    `, [bookingId]);

    const updatedBooking = await db.one(`
      UPDATE bookings
      SET "paidAmount" = $2, "updatedAt" = now()
      WHERE id = $1 RETURNING *
    `, [bookingId, sumResult.totalPaid]);

    bus.broadcast('payment.received', { organizationId, bookingId, paymentId: payment.id, amount: payment.amount });

    res.json({ ok: true, booking: updatedBooking, paidAmount: sumResult.totalPaid });
  }));

  /** Send a payment milestone reminder via WhatsApp */
  r.post('/:id/payments/:paymentId/remind', wrap(async (req, res) => {
    const organizationId = await orgId();
    const { paymentId, id: bookingId } = req.params;

    const payment = await db.one('SELECT * FROM payment_schedules WHERE id = $1 AND "bookingId" = $2 AND "organizationId" = $3', [paymentId, bookingId, organizationId]);
    if (!payment) throw fail(404, 'payment milestone not found');

    const booking = await db.one(`
      SELECT b.*, c.phone, c.name FROM bookings b
      LEFT JOIN contacts c ON c.id = b."contactId"
      WHERE b.id = $1
    `, [bookingId]);

    if (booking?.phone) {
      const msg = `Dear ${booking.name || 'Guest'},\n\nThis is a friendly reminder from 3dots Travel regarding your upcoming trip (Ref: ${booking.bookingReference}).\nMilestone: *${payment.title}*\nAmount Due: *INR ${Number(payment.amount).toLocaleString('en-IN')}*\nDue Date: ${new Date(payment.dueDate).toLocaleDateString('en-IN')}.\n\nPlease let us know once transferred!`;
      await sendWhatsAppMessage({ organizationId, to: booking.phone, text: msg, templateKey: 'payment_reminder' });
    }

    await db.query('UPDATE payment_schedules SET "reminderSentAt" = now(), "updatedAt" = now() WHERE id = $1', [payment.id]);
    res.json({ ok: true });
  }));

  return r;
};

