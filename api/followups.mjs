// Module 5: Follow-Up Automation API
import express from 'express';
import { db, orgId } from '../db/index.mjs';
import { wrap, fail, requireId, text } from './http.mjs';
import { processDueFollowups, cancelFollowupsForLead } from '../lib/followup.mjs';
import { sendWhatsAppMessage } from '../lib/whatsapp.mjs';

export const followupsRouter = () => {
  const r = express.Router();

  /** List scheduled follow-ups with lead context */
  r.get('/', wrap(async (req, res) => {
    const organizationId = await orgId();
    const leadId = req.query.leadId ? text(req.query.leadId) : null;
    const status = req.query.status ? text(req.query.status) : null;

    const where = ['f."organizationId" = $1'];
    const params = [organizationId];

    if (leadId) {
      params.push(leadId);
      where.push(`f."leadId" = $${params.length}`);
    }
    if (status) {
      params.push(status);
      where.push(`f.status = $${params.length}`);
    }

    const followups = await db.many(`
      SELECT f.*, l.title AS "leadTitle", l.destination AS "leadDestination", l.status AS "leadStatus",
             c.name AS "contactName", c.phone AS "contactPhone"
      FROM scheduled_followups f
      JOIN leads l ON l.id = f."leadId"
      LEFT JOIN contacts c ON c.id = f."contactId"
      WHERE ${where.join(' AND ')}
      ORDER BY f."scheduledFor" ASC
      LIMIT 100
    `, params);

    res.json({
      followups,
      pendingCount: followups.filter(f => f.status === 'pending').length,
    });
  }));

  /** Manually trigger pending follow-ups processor */
  r.post('/process', wrap(async (_req, res) => {
    const result = await processDueFollowups();
    res.json({ ok: true, ...result });
  }));

  /** Cancel all pending followups for a lead */
  r.post('/lead/:id/cancel', wrap(async (req, res) => {
    const organizationId = await orgId();
    const leadId = requireId(req.params.id, 'lead id');
    await cancelFollowupsForLead({ organizationId, leadId, reason: req.body?.reason || 'staff cancelled' });
    res.json({ ok: true });
  }));

  /** Immediately dispatch a single follow-up */
  r.post('/:id/send-now', wrap(async (req, res) => {
    const organizationId = await orgId();
    const item = await db.one('SELECT * FROM scheduled_followups WHERE id = $1 AND "organizationId" = $2', [req.params.id, organizationId]);
    if (!item) throw fail(404, 'no such follow-up');

    const payload = item.payload || {};
    if (item.channel === 'whatsapp' && payload.phone) {
      await sendWhatsAppMessage({
        organizationId,
        to: payload.phone,
        text: payload.text,
        templateKey: item.templateKey,
      });
    }

    const updated = await db.one('UPDATE scheduled_followups SET status = \'sent\', "sentAt" = now(), "updatedAt" = now() WHERE id = $1 RETURNING *', [item.id]);
    res.json({ ok: true, followup: updated });
  }));

  return r;
};

