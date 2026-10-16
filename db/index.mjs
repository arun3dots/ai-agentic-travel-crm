// The office database — the same PostgreSQL instance the travel platform has always used.
// Prisma created the tables; this app reads and writes them with plain SQL, so nothing about the
// data changes when the platform's schema file goes away.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

/**
 * A new row id.
 *
 * The tables were created by Prisma, which generates uuid()s in the client — the database has no
 * default on `id` — so every insert this app makes has to carry its own.
 */
export const newId = () => crypto.randomUUID();

/** Read KEY=value lines from a .env file (no dotenv dependency, no surprises with quotes). */
export function readEnvFile(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* no file: rely on the real environment */ }
  return out;
}

// .env wins over the ambient environment for the keys it defines — the office must talk to the
// database its .env names, not to whatever a shell happened to export.
export const env = { ...readEnvFile(path.join(root, '.env')), ...process.env };

if (!env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set — copy .env.example to .env and point it at the office database.');
}

const { Pool } = pg;

export const pool = new Pool({ connectionString: env.DATABASE_URL, max: 10 });

pool.on('error', e => console.error('[db] idle client error:', e.message));

export const db = {
  query: (text, params) => pool.query(text, params),
  one: async (text, params) => (await pool.query(text, params)).rows[0] || null,
  many: async (text, params) => (await pool.query(text, params)).rows,
  getClient: () => pool.connect(),
  end: () => pool.end(),
};

let orgCache = null;

/** The organization this office works as — ORG_SLUG from .env, else the one with the most calls. */
export async function org() {
  if (orgCache) return orgCache;
  const slug = env.ORG_SLUG;
  if (slug) {
    const row = await db.one('SELECT * FROM organizations WHERE slug = $1', [slug]);
    if (row) return (orgCache = row);
    const all = await db.many('SELECT slug FROM organizations ORDER BY "createdAt"');
    throw new Error(`ORG_SLUG="${slug}" does not match any organization. In the database: ${all.map(r => r.slug).join(', ')}`);
  }
  const row = await db.one(`
    SELECT o.* FROM organizations o
    LEFT JOIN calls c ON c."organizationId" = o.id
    GROUP BY o.id
    ORDER BY count(c.id) DESC, o."createdAt"
    LIMIT 1`);
  if (!row) throw new Error('no organization in the database — run db/seed.mjs first');
  return (orgCache = row);
}

export const orgId = async () => (await org()).id;
