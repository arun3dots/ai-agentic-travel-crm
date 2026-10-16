// Audit desk — the office's own record of what it did, and to what.
import express from 'express';
import { wrap, int } from './http.mjs';
import { recentAudit } from '../lib/audit.mjs';

export const auditRouter = () => {
  const r = express.Router();

  r.get('/', wrap(async (req, res) => {
    const entries = await recentAudit(int(req.query.limit, 100));
    const search = String(req.query.search || '').trim().toLowerCase();
    const filtered = search
      ? entries.filter(e => `${e.action} ${e.targetType || ''} ${e.actorLabel || ''} ${JSON.stringify(e.metadata || {})}`.toLowerCase().includes(search))
      : entries;
    res.json({ entries: filtered, total: filtered.length });
  }));

  return r;
};
