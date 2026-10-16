// Staff desk — who works the holiday desk and which team they sit on.
//
// A staff member is a `users` row plus a `memberships` row, which is how the platform has always
// modelled people; the role on the membership is the team (owner, admin, reservations, accounts...).
// Creating a staff member stores a real password hash (scrypt), so the same record can sign in later.
import crypto from 'node:crypto';
import express from 'express';
import { db, orgId, newId } from '../db/index.mjs';
import { wrap, fail, requireId, text, emailAddress } from './http.mjs';
import { logAudit } from '../lib/audit.mjs';

const DEFAULT_ROLES = ['owner', 'admin', 'reservations', 'operations', 'accounts', 'operator', 'viewer'];

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export const staffRouter = () => {
  const r = express.Router();

  r.get('/roles', (_req, res) => res.json({ roles: DEFAULT_ROLES }));

  r.get('/', wrap(async (_req, res) => {
    const organizationId = await orgId();
    const staff = await db.many(`
      SELECT u.id, u.email, u.name, u.status, u."lastLoginAt", u."createdAt",
             m.id AS "membershipId", m.role
      FROM users u
      JOIN memberships m ON m."userId" = u.id
      WHERE m."organizationId" = $1
      ORDER BY (m.role = 'owner') DESC, m.role, u.name`, [organizationId]);

    // The teams are the roles the memberships actually use, biggest first.
    const teams = await db.many(`
      SELECT m.role AS name, count(*)::int AS members
      FROM memberships m WHERE m."organizationId" = $1
      GROUP BY m.role ORDER BY members DESC, m.role`, [organizationId]);

    res.json({ staff, teams, roles: DEFAULT_ROLES });
  }));

  r.post('/', wrap(async (req, res) => {
    const organizationId = await orgId();
    const body = req.body || {};
    const name = text(body.name, { required: true, field: 'name', max: 200 });
    const email = emailAddress(body.email, { required: true });
    const role = text(body.role, { max: 40 }) || 'operator';
    const password = String(body.password || '').trim();
    if (password && password.length < 8) throw fail(400, 'the password must be at least 8 characters');

    let user = await db.one('SELECT id, email FROM users WHERE email = $1', [email]);
    if (!user) {
      user = await db.one(
        `INSERT INTO users (id, email, name, "passwordHash", status, "updatedAt")
         VALUES ($1,$2,$3,$4,'active', now()) RETURNING id, email`,
        [newId(), email, name, hashPassword(password || crypto.randomBytes(12).toString('hex'))]);
    } else {
      const already = await db.one('SELECT id FROM memberships WHERE "organizationId"=$1 AND "userId"=$2', [organizationId, user.id]);
      if (already) throw fail(409, `${email} is already on the team`);
      await db.query('UPDATE users SET name = $2, "updatedAt" = now() WHERE id = $1', [user.id, name]);
    }

    const membership = await db.one(
      `INSERT INTO memberships (id,"organizationId","userId",role) VALUES ($1,$2,$3,$4) RETURNING *`,
      [newId(), organizationId, user.id, role]);
    await logAudit({ action: 'staff.add', targetType: 'Staff', targetId: user.id, metadata: { name, email, role } });
    res.status(201).json({ staff: { id: user.id, email: user.email, name, role, status: 'active', membershipId: membership.id } });
  }));

  r.put('/:id', wrap(async (req, res) => {
    const id = requireId(req.params.id, 'staff id');
    const organizationId = await orgId();
    const body = req.body || {};
    const name = text(body.name, { required: true, field: 'name', max: 200 });
    const role = text(body.role, { max: 40 }) || 'operator';
    const status = ['active', 'disabled'].includes(body.status) ? body.status : 'active';

    const membership = await db.one(
      `UPDATE memberships SET role = $3 WHERE "organizationId" = $1 AND "userId" = $2 RETURNING id`,
      [organizationId, id, role]);
    if (!membership) throw fail(404, 'no such staff member');

    const user = await db.one(
      `UPDATE users SET name = $2, status = $3, "updatedAt" = now() WHERE id = $1 RETURNING id, email, name, status`,
      [id, name, status]);
    await logAudit({ action: 'staff.update', targetType: 'Staff', targetId: id, metadata: { name, role, status } });
    res.json({ staff: { ...user, role, membershipId: membership.id } });
  }));

  r.delete('/:id', wrap(async (req, res) => {
    const id = requireId(req.params.id, 'staff id');
    const organizationId = await orgId();
    const membership = await db.one(
      'SELECT id, role FROM memberships WHERE "organizationId"=$1 AND "userId"=$2', [organizationId, id]);
    if (!membership) throw fail(404, 'no such staff member');
    if (membership.role === 'owner') {
      const owners = await db.one(`SELECT count(*)::int AS n FROM memberships WHERE "organizationId"=$1 AND role='owner'`, [organizationId]);
      if (owners.n <= 1) throw fail(400, 'the office needs at least one owner');
    }
    await db.query('DELETE FROM memberships WHERE id=$1', [membership.id]);
    const removed = membership;
    const others = await db.one('SELECT count(*)::int AS n FROM memberships WHERE "userId" = $1', [id]);
    if (others.n === 0) await db.query('DELETE FROM users WHERE id = $1', [id]);
    await logAudit({ action: 'staff.remove', targetType: 'Staff', targetId: id, metadata: { role: removed.role } });
    res.json({ ok: true });
  }));

  return r;
};
