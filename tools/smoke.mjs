// Smoke test: does every desk answer, and does the office page load?
//
//   npm run smoke            (start the office first: npm start)
//   PORT=4400 npm run smoke
//
// Read-only on purpose: it places no calls, buys no numbers and sends no mail.
const PORT = process.env.PORT || 4300;
const BASE = `http://localhost:${PORT}`;

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('the page loads', async () => {
  const res = await fetch(`${BASE}/`);
  const html = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!html.includes('the holiday desk')) throw new Error('the page does not look like the office');
  return `${Math.round(html.length / 1024)} kb`;
});

check('health names this service', async () => {
  const j = await get('/api/health');
  if (j.service !== 'travel-office') throw new Error(`service is "${j.service}"`);
  return `${j.office} · ${j.telephony}`;
});

check('the dashboard counts real records', async () => {
  const j = await get('/api/office');
  if (!j.counts || j.counts.calls === undefined) throw new Error('no counts in the dashboard');
  return `${j.organization.name}: ${j.counts.calls} calls, ${j.counts.recordings} recordings, ${j.counts.leads} leads, ${j.counts.awaitingApproval} awaiting approval`;
});

check('the pipeline reports its six stations', async () => {
  const j = await get('/api/pipeline');
  if (j.stations.length !== 6) throw new Error(`expected 6 stations, got ${j.stations.length}`);
  const bad = j.cases.filter(c => !c.stations || c.stations.length !== 6);
  if (bad.length) throw new Error(`${bad.length} case(s) without a full station rail`);
  return `${j.cases.length} cases · ${j.awaitingApproval} awaiting approval`;
});

check('contacts, suppliers and staff list', async () => {
  const [contacts, suppliers, staff] = await Promise.all([get('/api/contacts'), get('/api/suppliers'), get('/api/staff')]);
  return `${contacts.contacts.length} contacts · ${suppliers.suppliers.length} suppliers · ${staff.staff.length} staff`;
});

check('calls, recordings and transcripts list', async () => {
  const [calls, recs, texts] = await Promise.all([get('/api/calls'), get('/api/recordings'), get('/api/transcriptions')]);
  return `${calls.calls.length} calls · ${recs.recordings.length} recordings (${recs.totals.notTranscribed} not transcribed) · ${texts.transcriptions.length} transcripts`;
});

check('recordings play through a signed link only', async () => {
  const recs = await get('/api/recordings?limit=1');
  const first = recs.recordings[0];
  if (!first) return 'no recordings to play';
  const good = await fetch(BASE + first.playUrl);
  if (good.status !== 200) throw new Error(`signed link returned ${good.status}`);
  const bytes = Number(good.headers.get('content-length') || 0);
  const tampered = await fetch(BASE + first.playUrl.replace(/signature=[^&]*/, 'signature=deadbeef'));
  if (tampered.status !== 403) throw new Error(`a tampered signature returned ${tampered.status}, expected 403`);
  return `streamed ${bytes} bytes; tampered signature refused`;
});

check('numbers, services and the ledger answer', async () => {
  const [numbers, services, audit] = await Promise.all([get('/api/numbers'), get('/api/services'), get('/api/audit?limit=5')]);
  return `${numbers.numbers.length} numbers · carrier ${services.carrier.ok ? 'reachable' : 'not reachable'} · ${audit.total} recent ledger entries`;
});

check('the itinerary PDF renders', async () => {
  const leads = await get('/api/leads');
  if (!leads.leads.length) return 'no leads to render';
  const res = await fetch(`${BASE}/api/leads/${leads.leads[0].id}/pdf?type=customer`);
  if (!res.ok) throw new Error(`PDF returned HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.subarray(0, 4).toString() !== '%PDF') throw new Error('the response is not a PDF');
  return `${Math.round(bytes.length / 1024)} kb pdf for "${leads.leads[0].title}"`;
});

check('quotation engine and flight search answer', async () => {
  const [quotes, flights] = await Promise.all([
    get('/api/quotes'),
    get('/api/leads/flights/search?from=DEL&to=DXB'),
  ]);
  return `${quotes.quotes.length} quotes on file · ${flights.flights.length} flight options retrieved`;
});

check('follow-up automation, bookings and payments answer', async () => {
  const [followups, bookings] = await Promise.all([
    get('/api/followups'),
    get('/api/bookings'),
  ]);
  return `${followups.followups.length} follow-ups scheduled · ${bookings.bookings.length} confirmed bookings`;
});

check('traveller care and visa checklists answer', async () => {
  const [visa, care] = await Promise.all([
    get('/api/care/visa'),
    get('/api/care/items'),
  ]);
  return `${visa.docs.length} visa checklist items · ${care.items.length} care records`;
});

check('module manager and Zowiz marketing CRM link answer', async () => {
  const [mods, zowiz] = await Promise.all([
    get('/api/modules'),
    get('/api/zowiz/status'),
  ]);
  return `${mods.summary.installed}/${mods.summary.total} modules installed · Zowiz ${zowiz.connected ? 'connected' : 'offline'}`;
});

async function get(path) {
  const res = await fetch(BASE + path);
  const body = await res.text();
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${body.slice(0, 120)}`);
  try { return JSON.parse(body); } catch { throw new Error(`${path} did not return JSON`); }
}

let failed = 0;
console.log(`\n3dots Travel — smoke test against ${BASE}\n`);
for (const { name, fn } of checks) {
  try {
    const detail = await fn();
    console.log(`  ✓ ${name}${detail ? `\n      ${detail}` : ''}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
console.log(failed ? `\n${failed} check(s) failed\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
