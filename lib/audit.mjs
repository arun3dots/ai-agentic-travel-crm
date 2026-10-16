// The audit trail. Every action the office takes on a lead, a call or a record lands here, and the
// Audit desk reads it back. Writing must never break the action itself, so failures are logged only.
import { db, orgId, newId } from '../db/index.mjs';

/**
 * @param {object} o
 * @param {string} o.action          e.g. 'lead.send_itinerary'
 * @param {string} [o.targetType]    'Lead' | 'Contact' | 'Call' | 'Supplier' | 'Staff'
 * @param {string} [o.targetId]
 * @param {object} [o.metadata]
 * @param {string} [o.actorLabel]    who did it (defaults to the operator at the desk)
 * @param {'user'|'agent'|'system'} [o.actorType]
 * @param {'success'|'failure'} [o.result]
 */
export async function logAudit(o) {
  try {
    await db.query(
      `INSERT INTO audit_logs (id,"organizationId","actorType","actorLabel",action,"targetType","targetId",metadata,result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [newId(), await orgId(), o.actorType || 'user', o.actorLabel || 'Holiday desk', o.action,
       o.targetType || null, o.targetId || null, o.metadata ? JSON.stringify(o.metadata) : null, o.result || 'success']
    );
  } catch (e) {
    console.warn('[audit] could not record the entry:', e.message);
  }
}

/** Recent entries for the Audit desk. */
export async function recentAudit(limit = 100) {
  return db.many(
    `SELECT a.id, a.action, a."targetType", a."targetId", a.metadata, a.result, a."actorLabel",
            a."createdAt", u.email AS "actorEmail"
     FROM audit_logs a
     LEFT JOIN users u ON u.id = a."actorUserId"
     WHERE a."organizationId" = $1
     ORDER BY a."createdAt" DESC
     LIMIT $2`,
    [await orgId(), Math.min(500, Number(limit) || 100)]
  );
}
