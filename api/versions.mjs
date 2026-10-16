// Module 3: Revisions & Version History API (Slide 8)
import express from 'express';
import { db, orgId, newId } from '../db/index.mjs';
import { wrap, fail, requireId, text } from './http.mjs';
import { logAudit } from '../lib/audit.mjs';
import { bus } from '../lib/events.mjs';

export const versionsRouter = () => {
  const r = express.Router();

  /** List all historical versions for a lead */
  r.get('/', wrap(async (req, res) => {
    const organizationId = await orgId();
    const leadId = requireId(req.query.leadId, 'leadId');

    const versions = await db.many(`
      SELECT id, "leadId", "versionNumber", title, destination, notes, author, "createdAt",
             length(coalesce(itinerary, '')) AS "itineraryLength",
             (pricing->>'finalSellingPrice') AS "price",
             (pricing->>'currency') AS "currency"
      FROM lead_versions
      WHERE "organizationId" = $1 AND "leadId" = $2
      ORDER BY "versionNumber" DESC
    `, [organizationId, leadId]);

    res.json({ versions });
  }));

  /** Get full detail of one specific version */
  r.get('/:id', wrap(async (req, res) => {
    const organizationId = await orgId();
    const version = await db.one(`
      SELECT * FROM lead_versions WHERE id = $1 AND "organizationId" = $2
    `, [req.params.id, organizationId]);
    if (!version) throw fail(404, 'no such version');

    res.json({ version });
  }));

  /** Restore a historical version to become the active lead itinerary */
  r.post('/:id/restore', wrap(async (req, res) => {
    const organizationId = await orgId();
    const version = await db.one(`
      SELECT * FROM lead_versions WHERE id = $1 AND "organizationId" = $2
    `, [req.params.id, organizationId]);
    if (!version) throw fail(404, 'no such version');

    const lead = await db.one('SELECT * FROM leads WHERE id = $1 AND "organizationId" = $2', [version.leadId, organizationId]);
    if (!lead) throw fail(404, 'associated lead not found');

    const newVersionNum = (lead.currentVersion || 1) + 1;

    // Snapshot current before restoring
    await db.query(`
      INSERT INTO lead_versions (
        id, "organizationId", "leadId", "versionNumber", title, destination,
        itinerary, flights, pricing, notes, author, "createdAt"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
    `, [
      newId(), organizationId, lead.id, lead.currentVersion || 1, lead.title, lead.destination,
      lead.itinerary, JSON.stringify(lead.flights || []), JSON.stringify(lead.pricing || {}),
      `Pre-restore auto-snapshot before restoring v${version.versionNumber}`, 'System',
    ]);

    // Restore historical data onto the lead
    const restored = await db.one(`
      UPDATE leads
      SET title = $2, destination = $3, itinerary = $4, flights = $5, pricing = $6,
          "currentVersion" = $7, "revisionNotes" = $8, status = 'pending_approval', "updatedAt" = now()
      WHERE id = $1 RETURNING *
    `, [
      lead.id, version.title, version.destination, version.itinerary,
      JSON.stringify(version.flights || []), JSON.stringify(version.pricing || {}),
      newVersionNum, `Restored from version ${version.versionNumber}: ${version.notes || ''}`,
    ]);

    await logAudit({
      action: 'version.restore',
      targetType: 'Lead',
      targetId: lead.id,
      metadata: { restoredFromVersion: version.versionNumber, newVersion: newVersionNum },
    });

    bus.broadcast('lead.revised', { organizationId, leadId: lead.id, restoredFromVersion: version.versionNumber });

    res.json({ ok: true, lead: restored, restoredVersion: version.versionNumber });
  }));

  return r;
};

