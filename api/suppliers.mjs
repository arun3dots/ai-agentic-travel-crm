// Supplier desk — the hotels, transport, activities and visa partners the office quotes.
import express from 'express';
import { db, orgId, newId } from '../db/index.mjs';
import { wrap, fail, requireId, text, phoneNumber, emailAddress } from './http.mjs';
import { logAudit } from '../lib/audit.mjs';

const CATEGORIES = ['hotels', 'transport', 'activities', 'flights', 'visa', 'insurance', 'cruise', 'dmc', 'other'];

export const suppliersRouter = () => {
  const r = express.Router();

  r.get('/categories', (_req, res) => res.json({ categories: CATEGORIES }));

  r.get('/', wrap(async (req, res) => {
    const search = String(req.query.search || '').trim();
    const category = String(req.query.category || '').trim();
    const params = [await orgId()];
    let where = 'WHERE s."organizationId" = $1';
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (s.name ILIKE $${params.length} OR s.email ILIKE $${params.length} OR coalesce(s."contactPerson",'') ILIKE $${params.length})`;
    }
    if (category) {
      params.push(category);
      where += ` AND s.category = $${params.length}`;
    }
    const suppliers = await db.many(`
      SELECT s.*,
             (SELECT count(*)::int FROM leads l WHERE l."selectedSupplierId" = s.id) AS "quoteCount",
             (SELECT max(l."supplierSentAt") FROM leads l WHERE l."selectedSupplierId" = s.id) AS "lastSentAt"
      FROM suppliers s ${where}
      ORDER BY s.name
      LIMIT 300`, params);
    res.json({ suppliers, categories: CATEGORIES });
  }));

  r.post('/', wrap(async (req, res) => {
    const organizationId = await orgId();
    const body = req.body || {};
    const name = text(body.name, { required: true, field: 'name', max: 200 });
    const email = emailAddress(body.email, { required: true });
    const category = CATEGORIES.includes(body.category) ? body.category : 'other';

    const existing = await db.one('SELECT id FROM suppliers WHERE "organizationId"=$1 AND email=$2', [organizationId, email]);
    if (existing) throw fail(409, `${email} is already on the supplier list`);

    const supplier = await db.one(
      `INSERT INTO suppliers (id,"organizationId", name, category, email, phone, "contactPerson", notes, "updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now()) RETURNING *`,
      [newId(), organizationId, name, category, email, phoneNumber(body.phone), text(body.contactPerson, { max: 200 }), text(body.notes, { max: 4000 })]);
    await logAudit({ action: 'supplier.create', targetType: 'Supplier', targetId: supplier.id, metadata: { name, email, category } });
    res.status(201).json({ supplier });
  }));

  r.put('/:id', wrap(async (req, res) => {
    const id = requireId(req.params.id, 'supplier id');
    const organizationId = await orgId();
    const body = req.body || {};
    const supplier = await db.one(
      `UPDATE suppliers SET name=$3, category=$4, email=$5, phone=$6, "contactPerson"=$7, notes=$8, "updatedAt"=now()
       WHERE id=$1 AND "organizationId"=$2 RETURNING *`,
      [id, organizationId, text(body.name, { required: true, field: 'name', max: 200 }),
       CATEGORIES.includes(body.category) ? body.category : 'other',
       emailAddress(body.email, { required: true }), phoneNumber(body.phone),
       text(body.contactPerson, { max: 200 }), text(body.notes, { max: 4000 })]);
    if (!supplier) throw fail(404, 'no such supplier');
    await logAudit({ action: 'supplier.update', targetType: 'Supplier', targetId: id, metadata: { name: supplier.name } });
    res.json({ supplier });
  }));

  r.delete('/:id', wrap(async (req, res) => {
    const id = requireId(req.params.id, 'supplier id');
    const supplier = await db.one('DELETE FROM suppliers WHERE id=$1 AND "organizationId"=$2 RETURNING id, name', [id, await orgId()]);
    if (!supplier) throw fail(404, 'no such supplier');
    await logAudit({ action: 'supplier.delete', targetType: 'Supplier', targetId: id, metadata: { name: supplier.name } });
    res.json({ ok: true });
  }));

  return r;
};
