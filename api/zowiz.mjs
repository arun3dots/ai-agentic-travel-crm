// Module 9: Zowiz Marketing CRM Integration (Slide 12)
import express from 'express';
import { db, orgId, newId } from '../db/index.mjs';
import { wrap, fail, text } from './http.mjs';
import { logAudit } from '../lib/audit.mjs';
import { bus } from '../lib/events.mjs';

export const zowizRouter = () => {
  const r = express.Router();

  /** Status check of Zowiz link */
  r.get('/status', wrap(async (req, res) => {
    const organizationId = await orgId();
    const syncLogs = await db.many(`
      SELECT * FROM audit_logs
      WHERE "organizationId" = $1 AND action LIKE 'zowiz.%'
      ORDER BY "createdAt" DESC
      LIMIT 10
    `, [organizationId]);

    res.json({
      connected: true,
      provider: 'Zowiz Marketing CRM v2',
      syncMode: 'bi-directional (webhooks + event bus)',
      recentSyncCount: syncLogs.length,
      recentSyncs: syncLogs,
    });
  }));

  /** Inbound Webhook: Zowiz pushes a new marketing lead into the Travel CRM */
  r.post('/webhook/inbound-lead', wrap(async (req, res) => {
    const organizationId = await orgId();
    const body = req.body || {};
    const name = text(body.customerName || body.name, { required: true, field: 'customerName', max: 150 });
    const phone = text(body.phone, { max: 40 });
    const email = text(body.email, { max: 120 });
    const destination = text(body.destination, { max: 150 }) || 'Unspecified';
    const campaign = text(body.campaign || body.source, { max: 100 }) || 'Zowiz Marketing';

    // 1. Find or create Contact
    let contact = null;
    if (phone || email) {
      contact = await db.one(`
        SELECT * FROM contacts 
        WHERE "organizationId" = $1 AND ((phone = $2 AND $2 IS NOT NULL) OR (email = $3 AND $3 IS NOT NULL))
        LIMIT 1
      `, [organizationId, phone, email]);
    }
    if (!contact) {
      contact = await db.one(`
        INSERT INTO contacts (id, "organizationId", name, phone, email, notes, "createdAt", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, $6, now(), now())
        RETURNING *
      `, [newId(), organizationId, name, phone, email, `Imported from Zowiz Campaign: ${campaign}`]);
    }

    // 2. Create Inbound Lead
    const lead = await db.one(`
      INSERT INTO leads (
        id, "organizationId", "contactId", title, destination, status, itinerary,
        "customerEmail", qualification, metadata, "createdAt", "updatedAt"
      ) VALUES ($1, $2, $3, $4, $5, 'new', $6, $7, $8, $9, now(), now())
      RETURNING *
    `, [
      newId(), organizationId, contact.id, `${name} - ${destination} Inquiry`, destination,
      `# ${name} - ${destination} Travel Inquiry\n\n**Source:** Zowiz Marketing CRM (${campaign})\n**Client:** ${name}\n**Destination:** ${destination}\n\n*Awaiting consultant consultation call.*`,
      email, JSON.stringify({ source: 'Zowiz Marketing', campaign, importedAt: new Date().toISOString() }),
      JSON.stringify({ zowizLeadId: body.zowizLeadId || body.id || null }),
    ]);

    await logAudit({
      action: 'zowiz.lead_pulled',
      targetType: 'Lead',
      targetId: lead.id,
      metadata: { campaign, customerName: name, destination },
    });

    bus.broadcast('zowiz.lead_pulled', { organizationId, leadId: lead.id, customerName: name });

    res.status(201).json({ ok: true, leadId: lead.id, contactId: contact.id });
  }));

  /** Outbound push: Push status of an inquiry or booking back to Zowiz */
  r.post('/sync-status', wrap(async (req, res) => {
    const organizationId = await orgId();
    const leadId = req.body?.leadId;
    if (!leadId) throw fail(400, 'leadId is required');

    const lead = await db.one('SELECT * FROM leads WHERE id = $1 AND "organizationId" = $2', [leadId, organizationId]);
    if (!lead) throw fail(404, 'lead not found');

    // Simulate or send push payload to Zowiz API
    const pushPayload = {
      leadId: lead.id,
      status: lead.status,
      title: lead.title,
      destination: lead.destination,
      pricing: lead.pricing,
      syncedAt: new Date().toISOString(),
    };

    console.log('[zowiz] pushing status back to Zowiz:', pushPayload);

    await logAudit({
      action: 'zowiz.status_pushed',
      targetType: 'Lead',
      targetId: lead.id,
      metadata: pushPayload,
    });

    bus.broadcast('zowiz.status_pushed', { organizationId, leadId: lead.id, status: lead.status });

    res.json({ ok: true, synced: pushPayload });
  }));

  return r;
};

