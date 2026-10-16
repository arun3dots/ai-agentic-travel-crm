// 3dots Travel — the holiday desk office.
//
// Express serves one page (the 3D office) and the office API behind it. There is no simulation here:
// every desk works on the real database, the real Plivo account, the real recordings and the real
// mail. What the office shows is what actually happened.
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createApiRouter } from './api/index.mjs';
import { org, pool } from './db/index.mjs';
import { runMigrations } from './db/migrations.mjs';
import { syncModuleRegistry } from './lib/modules.mjs';
import { processDueFollowups } from './lib/followup.mjs';
import * as plivo from './lib/plivo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4300);

const app = express();

// Plivo posts its callbacks as application/x-www-form-urlencoded, and its V3 signature is computed
// over the exact bytes it sent, so the body is parsed but never rewritten.
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: false, limit: '5mb' }));

app.use(express.static(join(__dirname, 'public')));
app.use('/api', createApiRouter());

// The office page, and the deep link the desk phone uses.
const page = join(__dirname, 'public', 'index.html');
app.get('/', (_req, res) => res.sendFile(page));
app.get('/desk', (_req, res) => res.sendFile(page));

app.use((req, res) => res.status(404).json({ error: `no such route: ${req.method} ${req.path}` }));
app.use((err, _req, res, _next) => {
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'the request body is not valid JSON' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'the request body is too large' });
  console.error('[office]', err.message);
  res.status(err.status || 500).json({ error: err.message });
});

const server = app.listen(PORT, async () => {
  const line = '  ';
  console.log('');
  console.log('  3dots TRAVEL — the holiday desk');
  console.log(`${line}office      http://localhost:${PORT}`);
  try {
    const organization = await org();
    await runMigrations();
    await syncModuleRegistry();
    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM calls WHERE "organizationId"=$1) AS calls,
         (SELECT count(*)::int FROM recordings WHERE "organizationId"=$1) AS recordings,
         (SELECT count(*)::int FROM leads WHERE "organizationId"=$1 AND status='pending_approval') AS awaiting`,
      [organization.id]);
    console.log(`${line}working as  ${organization.name} (${organization.slug})`);
    console.log(`${line}on file     ${rows[0].calls} calls · ${rows[0].recordings} recordings · ${rows[0].awaiting} waiting for approval`);
  } catch (e) {
    console.log(`${line}database    NOT REACHABLE — ${e.message}`);
  }
  console.log(`${line}plivo       ${plivo.configured() ? `configured (${plivo.callerId()})` : 'not configured'}`);
  console.log(`${line}webhook     ${plivo.webhookBase() || 'no PUBLIC_URL set — Plivo cannot reach this office yet'}`);
  console.log('');

  // Automatic background scheduler: poll due follow-up chasing items every 60s
  const timer = setInterval(() => {
    processDueFollowups().catch(err => console.error('[scheduler] followup error:', err.message));
  }, 60000);
  server._followupTimer = timer;
});

const shutdown = async () => {
  if (server._followupTimer) clearInterval(server._followupTimer);
  server.close();
  await pool.end().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
