// Contacts desk — the people the office calls. Add, edit, search, delete; the dialer picks from here.
import express from 'express';
import { db, orgId, newId } from '../db/index.mjs';
import { wrap, fail, requireId, text, phoneNumber, emailAddress } from './http.mjs';
import { logAudit } from '../lib/audit.mjs';

export const contactsRouter = () => {
  const r = express.Router();

  r.get('/', wrap(async (req, res) => {
    const search = String(req.query.search || '').trim();
    const params = [await orgId()];
    let where = 'WHERE c."organizationId" = $1';
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (c.name ILIKE $2 OR c.phone ILIKE $2 OR coalesce(c.email,'') ILIKE $2 OR coalesce(c.company,'') ILIKE $2)`;
    }
    const contacts = await db.many(`
      SELECT c.*,
             (SELECT count(*)::int FROM calls k WHERE k."organizationId" = c."organizationId"
                AND (k."from" = c.phone OR k."to" = c.phone)) AS "callCount",
             (SELECT count(*)::int FROM leads l WHERE l."contactId" = c.id) AS "leadCount",
             (SELECT max(k."startedAt") FROM calls k
                WHERE k."organizationId" = c."organizationId" AND (k."from" = c.phone OR k."to" = c.phone)) AS "lastCallAt"
      FROM contacts c
      ${where}
      ORDER BY c."createdAt" DESC
      LIMIT 300`, params);
    res.json({ contacts });
  }));

  r.get('/:id', wrap(async (req, res) => {
    const id = requireId(req.params.id, 'contact id');
    const contact = await db.one('SELECT * FROM contacts WHERE id = $1 AND "organizationId" = $2', [id, await orgId()]);
    if (!contact) throw fail(404, 'no such contact');
    const calls = await db.many(
      `SELECT * FROM calls WHERE "organizationId" = $1 AND ("from" = $2 OR "to" = $2) ORDER BY "startedAt" DESC LIMIT 20`,
      [contact.organizationId, contact.phone]);
    const leads = await db.many('SELECT id, title, destination, status, "createdAt" FROM leads WHERE "contactId" = $1 ORDER BY "createdAt" DESC', [id]);
    res.json({ contact, calls, leads });
  }));

  r.post('/', wrap(async (req, res) => {
    const organizationId = await orgId();
    const body = req.body || {};
    const name = text(body.name, { required: true, field: 'name', max: 200 });
    const phone = phoneNumber(body.phone, { required: true });
    const email = emailAddress(body.email, { field: 'email' });
    const company = text(body.company, { max: 200 });
    const notes = text(body.notes, { max: 4000 });

    const existing = await db.one('SELECT id FROM contacts WHERE "organizationId" = $1 AND phone = $2', [organizationId, phone]);
    if (existing) throw fail(409, `${phone} is already on the contact list`);

    const contact = await db.one(
      `INSERT INTO contacts (id,"organizationId", name, phone, email, company, notes, "updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7, now()) RETURNING *`,
      [newId(), organizationId, name, phone, email, company, notes]);
    await logAudit({ action: 'contact.create', targetType: 'Contact', targetId: contact.id, metadata: { name, phone } });
    res.status(201).json({ contact });
  }));

  r.put('/:id', wrap(async (req, res) => {
    const id = requireId(req.params.id, 'contact id');
    const organizationId = await orgId();
    const body = req.body || {};
    const name = text(body.name, { required: true, field: 'name', max: 200 });
    const phone = phoneNumber(body.phone, { required: true });
    const email = emailAddress(body.email, { field: 'email' });
    const contact = await db.one(
      `UPDATE contacts SET name=$3, phone=$4, email=$5, company=$6, notes=$7, "updatedAt"=now()
       WHERE id=$1 AND "organizationId"=$2 RETURNING *`,
      [id, organizationId, name, phone, email, text(body.company, { max: 200 }), text(body.notes, { max: 4000 })]);
    if (!contact) throw fail(404, 'no such contact');
    await logAudit({ action: 'contact.update', targetType: 'Contact', targetId: id, metadata: { name, phone } });
    res.json({ contact });
  }));

  r.delete('/:id', wrap(async (req, res) => {
    const id = requireId(req.params.id, 'contact id');
    const contact = await db.one('DELETE FROM contacts WHERE id=$1 AND "organizationId"=$2 RETURNING id, name', [id, await orgId()]);
    if (!contact) throw fail(404, 'no such contact');
    await logAudit({ action: 'contact.delete', targetType: 'Contact', targetId: id, metadata: { name: contact.name } });
    res.json({ ok: true });
  }));

  return r;
};
