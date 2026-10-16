// The desks.
//
// Clicking an agent in the office opens the desk that agent owns; the nav down the left switches
// between them without leaving the page. Every desk reads and writes the same database the pipeline
// runs on, so what is shown here is the state of the office, not a mock of it.
import { api, fmt, h } from './api.js';
import { DESKS, DEPTS } from './data.js';

const NAV = [
  { group: 'THE PIPELINE', desks: ['pipeline', 'calls', 'recordings', 'transcriptions', 'design', 'quotes', 'revisions', 'approvals', 'despatch'] },
  { group: 'AUTOMATION & CARE', desks: ['followups', 'bookings', 'care'] },
  { group: 'THE RECORDS', desks: ['contacts', 'suppliers', 'staff'] },
  { group: 'THE OFFICE', desks: ['phone', 'numbers', 'audit', 'modules'] },
];

// `design` is the leads desk under its pipeline name.
const PANEL_FOR = { design: 'leads' };

let overlay, bodyEl, navEl, titleEl, blurbEl, toastEl;
let deps = {};              // { zoomToDept, softphone, refresh, agentFor }
let currentDesk = null;
let currentParams = {};

export function initDesks(dependencies = {}) {
  deps = dependencies;
  if (overlay) return api_exports();

  injectCss();

  toastEl = h('div', { id: 'dkToast', class: 'dk-toast' });
  navEl = h('nav', { class: 'dk-nav' });
  titleEl = h('h2', { class: 'dk-title', text: 'THE OFFICE' });
  blurbEl = h('p', { class: 'dk-blurb' });
  bodyEl = h('div', { class: 'dk-body' }, [h('div', { class: 'dk-empty', text: 'Pick a desk.' })]);

  const close = h('button', { class: 'dk-x', title: 'close (Esc)', text: '✕', onclick: () => api_exports().close() });

  overlay = h('div', { id: 'dkOv', class: 'dk-ov' }, [
    h('div', { class: 'dk-panel' }, [
      h('header', { class: 'dk-head' }, [
        h('div', { class: 'dk-head-t' }, [titleEl, blurbEl]),
        close,
      ]),
      h('div', { class: 'dk-main' }, [navEl, bodyEl]),
    ]),
    toastEl,
  ]);
  document.body.appendChild(overlay);

  overlay.addEventListener('click', e => { if (e.target === overlay) api_exports().close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && overlay.classList.contains('open')) api_exports().close(); });

  buildNav();

  // The office's own button, in the top bar next to the phone.
  const btn = h('button', { id: 'deskBtn', class: 'dk-topbtn', html: '<b>▦</b> DESKS', title: 'open the desks', onclick: () => api_exports().open('pipeline') });
  const anchor = document.getElementById('spBtn');
  const bar = document.getElementById('topbar');
  if (bar) bar.insertBefore(btn, anchor || document.getElementById('clock') || null);

  return api_exports();

  function api_exports() {
    return {
      /** Open a desk. `desk` is a key from DESKS; `params` can carry { id, search, focus }. */
      open: (desk, params = {}) => openDesk(desk, params),
      close: () => { overlay.classList.remove('open'); currentDesk = null; },
      current: () => currentDesk,
      refresh: () => (currentDesk ? render(currentDesk, currentParams) : null),
      /** Draw attention to a desk's count in the nav (called when the pipeline moves). */
      bump: () => buildNav(),
      toast,
    };
  }
}

function injectCss() {
  if (document.getElementById('dkCss')) return;
  const st = document.createElement('style');
  st.id = 'dkCss';
  st.textContent = `
#dkOv{position:fixed;inset:0;z-index:80;display:none;background:rgba(12,16,22,.38);backdrop-filter:blur(3px)}
#dkOv.open{display:block}
.dk-panel{position:absolute;inset:34px 40px;background:#fff;border-radius:18px;box-shadow:0 30px 90px rgba(10,20,30,.36);display:flex;flex-direction:column;overflow:hidden;font:13px/1.5 var(--font-sans);color:#1c232b}
.dk-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:16px 20px;border-bottom:1px solid #eef1f4;background:linear-gradient(180deg,#fbfdfd,#fff)}
.dk-title{margin:0;font:700 15px/1.2 var(--font-sans);letter-spacing:.10em;text-transform:uppercase;color:#0f172a}
.dk-blurb{margin:5px 0 0;font-size:12px;color:#64748b;max-width:900px}
.dk-x{border:1px solid #d8dee5;background:#fff;border-radius:9px;height:30px;min-width:34px;font:600 13px var(--font-sans);cursor:pointer;color:#475569}
.dk-x:hover{background:#f1f5f9}
.dk-main{flex:1;display:flex;min-height:0}
.dk-nav{width:210px;flex:0 0 210px;border-right:1px solid #eef1f4;padding:12px 10px;overflow:auto;background:#fbfcfd}
.dk-nav h4{margin:12px 8px 6px;font:700 10px var(--font-sans);letter-spacing:.13em;color:#94a3b8}
.dk-nav h4:first-child{margin-top:2px}
.dk-nav button{display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;text-align:left;padding:7px 9px;border-radius:8px;font:600 11.5px var(--font-sans);letter-spacing:.05em;color:#334155;cursor:pointer}
.dk-nav button:hover{background:#eef4f3}
.dk-nav button.on{background:#e6f4f1;color:#1B6C5F}
.dk-nav .dg{width:7px;height:7px;border-radius:50%;flex:0 0 7px}
.dk-nav .n{margin-left:auto;font:600 10px var(--font-mono);background:#f1f5f9;border-radius:20px;padding:1px 7px;color:#475569}
.dk-nav .n.hot{background:#fee2e2;color:#b91c1c}
.dk-body{flex:1;min-width:0;overflow:auto;padding:16px 20px 26px;-webkit-overflow-scrolling:touch}
.dk-empty{color:#94a3b8;font-size:12.5px;padding:24px 4px}
.dk-bar{display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap}
.dk-bar .sp{flex:1}
.dk-in,.dk-sel{height:32px;border:1px solid #d8dee5;border-radius:9px;padding:0 10px;font:12.5px var(--font-sans);background:#fff;color:#1c232b;min-width:0}
.dk-in:focus,.dk-sel:focus{outline:2px solid #cdeae4;border-color:#8fd3c7}
textarea.dk-in{height:auto;min-height:76px;padding:8px 10px;line-height:1.5;resize:vertical;font-family:var(--font-mono);font-size:12px}
.dk-btn{height:32px;border:0;border-radius:9px;padding:0 13px;font:600 11.5px var(--font-sans);letter-spacing:.03em;cursor:pointer;background:#0e9b8f;color:#fff;white-space:nowrap}
.dk-btn:hover{filter:brightness(1.06)}
.dk-btn.ghost{background:#f1f5f9;color:#334155}
.dk-btn.dark{background:#1f2937}
.dk-btn.warn{background:#dc2626}
.dk-btn:disabled{opacity:.45;cursor:not-allowed}
.dk-btn.sm{height:26px;padding:0 9px;font-size:11px}
.dk-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 -4px;padding:0 4px}
table.dk-t{width:100%;border-collapse:collapse;font-size:12.5px}
table.dk-t th{text-align:left;font:700 10px var(--font-sans);letter-spacing:.09em;text-transform:uppercase;color:#94a3b8;padding:0 10px 7px;border-bottom:1px solid #eef1f4;white-space:nowrap}
table.dk-t td{padding:9px 10px;border-bottom:1px solid #f4f7f9;vertical-align:top}
table.dk-t tr.row:hover td{background:#fafcfc}
table.dk-t tr.row{cursor:default}
.dk-mono{font:12px var(--font-mono)}
.dk-when{font:11.5px var(--font-mono);color:#64748b;white-space:nowrap}
.dk-dim{color:#94a3b8}
.dk-strong{font-weight:600;color:#0f172a}
.chip{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:20px;font:600 10px var(--font-sans);letter-spacing:.05em;text-transform:uppercase;background:#f1f5f9;color:#475569;white-space:nowrap}
.chip.done{background:#dcfce7;color:#15803d}
.chip.active{background:#fef3c7;color:#b45309}
.chip.ready{background:#e0f2fe;color:#0369a1}
.chip.waiting{background:#f1f5f9;color:#94a3b8}
.chip.blocked{background:#fee2e2;color:#b91c1c}
.chip.pending_approval{background:#fce7f3;color:#be185d}
.chip.approved{background:#dbeafe;color:#1d4ed8}
.chip.sent_to_customer,.chip.sent_to_supplier,.chip.converted{background:#dcfce7;color:#15803d}
.chip.rejected{background:#fee2e2;color:#b91c1c}
.chip.draft{background:#f1f5f9;color:#64748b}
.dk-rail{display:flex;gap:4px;align-items:center}
.dk-rail i{display:block;height:5px;width:22px;border-radius:9px;background:#e2e8f0}
.dk-rail i.done{background:#34d399}
.dk-rail i.active{background:#fbbf24}
.dk-rail i.blocked{background:#f87171}
.dk-grid{display:grid;grid-template-columns:minmax(320px,1fr) minmax(340px,1.25fr);gap:16px}
.dk-card{border:1px solid #eef1f4;border-radius:12px;padding:14px;background:#fff;min-width:0}
.dk-card h3{margin:0 0 10px;font:700 11px var(--font-sans);letter-spacing:.1em;text-transform:uppercase;color:#475569}
.dk-kv{display:grid;grid-template-columns:132px 1fr;gap:6px 10px;font-size:12.5px;margin:0}
.dk-kv dt{color:#94a3b8;font:600 10px var(--font-sans);letter-spacing:.07em;text-transform:uppercase;padding-top:2px}
.dk-kv dd{margin:0;color:#1c232b;word-break:break-word}
.doc{white-space:pre-wrap;font:12.5px/1.65 var(--font-mono);background:#fbfcfd;border:1px solid #eef1f4;border-radius:10px;padding:14px;max-height:420px;overflow:auto}
.dk-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dk-sep{height:1px;background:#eef1f4;margin:14px 0}
.dk-note{font-size:11.5px;color:#64748b;background:#f8fafc;border:1px solid #eef1f4;border-radius:9px;padding:8px 10px}
.dk-err{font-size:11.5px;color:#b91c1c;background:#fef2f2;border:1px solid #fee2e2;border-radius:9px;padding:8px 10px}
audio{height:32px;vertical-align:middle;max-width:260px}
.dk-modal{position:absolute;inset:0;background:rgba(15,23,42,.35);display:flex;align-items:center;justify-content:center;z-index:5;padding:16px}
.dk-sheet{background:#fff;border-radius:14px;box-shadow:0 24px 60px rgba(10,20,30,.35);width:min(560px,100%);max-height:100%;overflow:auto}
.dk-sheet h3{margin:0;padding:15px 18px;border-bottom:1px solid #eef1f4;font:700 11.5px var(--font-sans);letter-spacing:.1em;text-transform:uppercase;color:#475569}
.dk-sheet form{padding:16px 18px}
.dk-field{margin-bottom:12px}
.dk-field label{display:block;font:600 10px var(--font-sans);letter-spacing:.08em;text-transform:uppercase;color:#94a3b8;margin-bottom:5px}
.dk-field input,.dk-field select,.dk-field textarea{width:100%;box-sizing:border-box;border:1px solid #d8dee5;border-radius:9px;padding:9px 10px;font:12.5px var(--font-sans);color:#1c232b;background:#fff}
.dk-field input,.dk-field select{height:38px}
.dk-field textarea{min-height:90px;font-family:var(--font-mono);line-height:1.5}
.dk-foot{display:flex;justify-content:flex-end;gap:8px;padding-top:6px}
.dk-topbtn{display:inline-flex;align-items:center;gap:7px;height:30px;padding:0 13px;margin-left:8px;border-radius:999px;border:1px solid rgba(37,140,123,.35);background:#fff;color:#1B6C5F;font:600 11px/1 var(--font-sans);letter-spacing:.06em;cursor:pointer}
.dk-topbtn:hover{background:#f2faf8}
.dk-toast{position:absolute;left:50%;bottom:26px;transform:translateX(-50%);background:#0f172a;color:#fff;border-radius:10px;padding:9px 15px;font:12.5px var(--font-sans);box-shadow:0 14px 40px rgba(10,20,30,.35);opacity:0;pointer-events:none;transition:opacity .18s;max-width:calc(100% - 32px);text-align:center}
.dk-toast.on{opacity:1}
.dk-toast.bad{background:#b91c1c}
.dk-toast.good{background:#047857}

/* ======================= phones and small tablets ======================= */
@media (max-width: 900px){
  #dkOv{background:#fff;backdrop-filter:none}
  .dk-panel{position:absolute;inset:0;border-radius:0;box-shadow:none;height:100%}
  .dk-head{padding:12px 14px;gap:10px}
  .dk-title{font-size:13px;letter-spacing:.08em}
  .dk-blurb{display:none}
  .dk-x{height:34px;min-width:38px}
  .dk-main{flex-direction:column}
  /* the nav becomes a swipeable strip of tabs, so nothing is hidden behind a drawer */
  .dk-nav{width:auto;flex:0 0 auto;display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;
    border-right:0;border-bottom:1px solid #eef1f4;padding:9px 12px;background:#fbfcfd}
  .dk-nav::-webkit-scrollbar{display:none}
  .dk-nav h4{display:none}
  .dk-nav button{width:auto;flex:0 0 auto;border:1px solid #e6ebf0;background:#fff;border-radius:20px;
    padding:7px 13px;font-size:11px;white-space:nowrap}
  .dk-nav button.on{background:#e6f4f1;border-color:#BFE3DA;color:#1B6C5F}
  .dk-nav .dg{display:none}
  .dk-nav .n{margin-left:2px}
  .dk-body{padding:14px 14px 34px}
  .dk-grid{grid-template-columns:1fr}
  .dk-bar{gap:6px}
  .dk-in,.dk-sel{flex:1 1 150px}
  .dk-btn{height:36px;padding:0 14px}
  .dk-btn.sm{height:30px}
  .dk-kv{grid-template-columns:1fr;gap:2px 0}
  .dk-kv dt{margin-top:8px}
  .dk-doc,.doc{max-height:none}
  table.dk-t{min-width:620px}
  .dk-sheet{width:100%}
  .dk-modal{align-items:flex-end;padding:0}
  .dk-sheet{border-radius:16px 16px 0 0;max-height:92vh}
  .dk-sheet form{padding-bottom:calc(16px + env(safe-area-inset-bottom))}
  .dk-field input,.dk-field select{height:42px;font-size:14px}
  .dk-field textarea{font-size:14px}
  .dk-topbtn{height:34px;padding:0 12px;font-size:10.5px;margin-left:0}
}
@media (max-width: 480px){
  .dk-title{font-size:12px}
  .dk-nav button{font-size:10.5px;padding:6px 11px}
  .dk-body{padding:12px 12px 30px}
  .dk-card{padding:12px}
}
`;
  document.head.appendChild(st);
}

function toast(message, kind = '') {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.className = `dk-toast on ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toastEl.className = 'dk-toast'; }, kind === 'bad' ? 5200 : 2800);
}

/** Wrap an action so the button disables, errors surface, and the panel refreshes afterwards. */
async function run(button, work, { refresh = true, done = 'done' } = {}) {
  const label = button?.textContent;
  if (button) { button.disabled = true; button.textContent = '…'; }
  try {
    const out = await work();
    if (done) toast(typeof done === 'string' ? done : 'done', 'good');
    if (refresh && currentDesk) await render(currentDesk, currentParams);
    deps.refresh?.();
    return out;
  } catch (e) {
    toast(e.message, 'bad');
    throw e;
  } finally {
    if (button) { button.disabled = false; button.textContent = label; }
  }
}

/* ---------- the shell ---------- */

function buildNav() {
  navEl.innerHTML = '';
  for (const group of NAV) {
    navEl.appendChild(h('h4', { text: group.group }));
    for (const key of group.desks) {
      const desk = DESKS[key];
      if (!desk) continue;
      const dept = DEPTS[desk.pod] || {};
      const b = h('button', { 'data-desk': key, onclick: () => openDesk(key) }, [
        h('span', { class: 'dg', style: `background:${dept.chip || '#94a3b8'}` }),
        h('span', { text: desk.title }),
        h('span', { class: 'n', 'data-count': key, style: 'display:none' }),
      ]);
      navEl.appendChild(b);
    }
  }
  paintCounts();
}

/** Small counts beside the nav items, so the office's state is readable from the shell. */
async function paintCounts() {
  try {
    const [leads, recs, approvals] = await Promise.all([
      api.get('/leads'), api.get('/recordings?limit=1'), api.get('/pipeline'),
    ]);
    setCount('pipeline', leads.leads.length);
    setCount('design', leads.leads.length);
    setCount('revisions', leads.leads.filter(l => l.revisionNotes).length);
    setCount('recordings', recs.totals.notTranscribed, true);
    setCount('approvals', approvals.awaitingApproval, true);
  } catch { /* the office may be offline; the nav just stays clean */ }
  function setCount(key, n, hot = false) {
    const el = navEl.querySelector(`[data-count="${key}"]`);
    if (!el) return;
    if (!n) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.textContent = String(n);
    el.className = `n${hot ? ' hot' : ''}`;
  }
}

async function openDesk(deskKey, params = {}) {
  if (!DESKS[deskKey]) deskKey = 'pipeline';
  overlay.classList.add('open');
  await render(deskKey, params);
  paintCounts();
}

async function render(deskKey, params = {}) {
  currentDesk = deskKey;
  currentParams = params;
  const desk = DESKS[deskKey];
  const dept = DEPTS[desk.pod] || {};
  titleEl.textContent = desk.title;
  blurbEl.textContent = desk.blurb;
  titleEl.style.color = dept.ink || '#0f172a';
  for (const b of navEl.querySelectorAll('button')) b.classList.toggle('on', b.dataset.desk === deskKey);
  bodyEl.innerHTML = '';
  bodyEl.appendChild(h('div', { class: 'dk-empty', text: 'loading…' }));

  const panel = PANEL_FOR[deskKey] || deskKey;
  const renderer = PANELS[panel];
  try {
    const content = renderer
      ? await renderer(params)
      : h('div', { class: 'dk-empty', text: 'This desk has nothing on it yet.' });
    bodyEl.innerHTML = '';
    bodyEl.appendChild(content);
  } catch (e) {
    bodyEl.innerHTML = '';
    bodyEl.appendChild(h('div', { class: 'dk-err', text: e.message }));
  }
}

/* ---------- shared bits ---------- */

const statusChip = value => h('span', { class: `chip ${value}`, text: fmt.status(value) });

function stationRail(caseRow) {
  return h('span', { class: 'dk-rail', title: `next: ${caseRow.next || '—'}` },
    caseRow.stations.map(s => h('i', { class: s.state, title: `${s.key}: ${s.state} — ${s.note}` })));
}

function table(columns, rows, { empty = 'nothing on file yet' } = {}) {
  if (!rows.length) return h('div', { class: 'dk-empty', text: empty });
  return h('div', { class: 'dk-scroll' }, [
    h('table', { class: 'dk-t' }, [
      h('thead', {}, [h('tr', {}, columns.map(c => h('th', { text: c.label })))]),
      h('tbody', {}, rows.map(r => h('tr', { class: 'row' }, columns.map(c => h('td', {}, [c.cell(r)]))))),
    ]),
  ]);
}

/** The created-at cell every record carries, so the newest row is obvious. */
const when = value => h('span', { class: 'dk-when', text: fmt.when(value), title: value ? new Date(value).toLocaleString('en-IN') : '' });

/** A small modal form. `fields` are { name, label, type, value, options, placeholder, required }. */
function openForm({ title, fields, submitLabel = 'SAVE', onSubmit, hint }) {
  const modal = h('div', { class: 'dk-modal' });
  const inputs = {};
  const form = h('form', {
    onsubmit: async e => {
      e.preventDefault();
      const values = {};
      for (const f of fields) {
        const el = inputs[f.name];
        values[f.name] = f.type === 'checkbox' ? el.checked : el.value;
      }
      const btn = form.querySelector('button[type=submit]');
      await run(btn, () => onSubmit(values), { refresh: false, done: false }).then(() => {
        modal.remove();
        toast('saved', 'good');
        if (currentDesk) render(currentDesk, currentParams);
        deps.refresh?.();
      }).catch(() => {});
    },
  }, fields.map(f => {
    const el = f.type === 'select'
      ? h('select', {}, f.options.map(o => h('option', { value: o.value, selected: String(o.value) === String(f.value ?? '') }, [o.label])))
      : f.type === 'textarea'
        ? h('textarea', { placeholder: f.placeholder || '' }, [f.value || ''])
        : h('input', { type: f.type || 'text', value: f.value ?? '', placeholder: f.placeholder || '', required: f.required, step: f.step, min: f.min });
    inputs[f.name] = el;
    return h('div', { class: 'dk-field' }, [h('label', { text: f.label }), el]);
  }).concat([
    hint ? h('div', { class: 'dk-note', text: hint }) : null,
    h('div', { class: 'dk-foot' }, [
      h('button', { class: 'dk-btn ghost', type: 'button', text: 'CANCEL', onclick: () => modal.remove() }),
      h('button', { class: 'dk-btn', type: 'submit', text: submitLabel }),
    ]),
  ]));

  modal.appendChild(h('div', { class: 'dk-sheet' }, [h('h3', { text: title }), form]));
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  overlay.querySelector('.dk-panel').appendChild(modal);
  setTimeout(() => Object.values(inputs)[0]?.focus(), 30);
  return modal;
}

const field = (name, label, extra = {}) => ({ name, label, ...extra });

/* ---------- the panels ---------- */

const PANELS = {};

/* LEADS / THE PIPELINE ---------------------------------------------------- */
PANELS.pipeline = async params => {
  const data = await api.get('/pipeline');
  const wrap = h('div');

  wrap.appendChild(h('div', { class: 'dk-bar' }, [
    h('button', { class: 'dk-btn', text: '+ NEW CALL', onclick: () => openDesk('calls', { new: true }) }),
    h('button', { class: 'dk-btn ghost', text: 'CONTACTS', onclick: () => openDesk('contacts') }),
    h('span', { class: 'sp' }),
    h('span', { class: 'dk-dim', text: `${data.cases.length} cases · ${data.awaitingApproval} waiting for approval · ${data.inFlight} in flight` }),
  ]));

  const stations = h('div', { class: 'dk-card' }, [
    h('h3', { text: 'THE SIX STATIONS' }),
    h('div', { class: 'dk-row' }, data.stations.map((s, i) => h('div', { style: 'flex:1;min-width:118px' }, [
      h('div', { style: 'display:flex;align-items:center;gap:6px' }, [
        h('span', { class: 'chip', style: 'background:#f1f5f9', text: String(i + 1) }),
        h('span', { class: 'dk-strong', style: 'font-size:11.5px', text: s.name }),
      ]),
      h('div', { class: 'dk-dim', style: 'font-size:11px;margin-top:4px', text: `${data.stationCounts[s.key]?.done ?? 0} done · ${data.stationCounts[s.key]?.waiting ?? 0} open` }),
    ]))),
  ]);
  wrap.appendChild(stations);
  wrap.appendChild(h('div', { class: 'dk-sep' }));

  wrap.appendChild(h('h3', { style: 'margin:0 0 8px;font:700 11px var(--font-sans);letter-spacing:.1em;color:#475569', text: 'CASES' }));
  wrap.appendChild(table([
    { label: 'Created', cell: c => when(c.createdAt) },
    { label: 'Status', cell: c => statusChip(c.status) },
    { label: 'Trip', cell: c => h('div', {}, [
      h('div', { class: 'dk-strong', text: c.title }),
      h('div', { class: 'dk-dim', text: [c.destination, c.contact?.name].filter(Boolean).join(' · ') || '—' }),
    ]) },
    { label: 'Stations', cell: c => stationRail(c) },
    { label: 'Next', cell: c => h('span', { class: 'chip ready', text: c.next ? (data.stations.find(s => s.key === c.next)?.name || c.next) : 'complete' }) },
    { label: 'Updated', cell: c => when(c.updatedAt) },
    { label: '', cell: c => h('button', { class: 'dk-btn sm', text: 'OPEN', onclick: () => openDesk('pipeline', { id: c.id }) }) },
  ], data.cases, { empty: 'No cases yet — place a call from the CALL DESK and everything follows.' }));

  if (params.id) wrap.appendChild(await caseDetail(params.id));
  return wrap;
};

async function caseDetail(id) {
  const data = await api.get(`/pipeline/${encodeURIComponent(id)}`);
  const c = data.case;
  const card = h('div', { class: 'dk-card', style: 'margin-top:16px' });

  card.appendChild(h('h3', { text: `CASE · ${c.title}` }));
  card.appendChild(h('div', { class: 'dk-row', style: 'margin-bottom:10px' }, [
    statusChip(c.status),
    h('span', { class: 'dk-dim', text: c.contact?.name ? `guest: ${c.contact.name}` : 'no matching contact' }),
    h('span', { class: 'dk-when', text: `created ${fmt.when(c.createdAt)}` }),
  ]));
  card.appendChild(h('div', { class: 'dk-row', style: 'margin-bottom:12px' }, c.stations.map(s =>
    h('div', { style: 'border:1px solid #eef1f4;border-radius:10px;padding:8px 10px;min-width:150px' }, [
      h('div', { class: 'dk-row', style: 'gap:6px' }, [h('span', { class: `chip ${s.state}`, text: s.state }), h('span', { class: 'dk-strong', style: 'font-size:11px', text: s.key })]),
      h('div', { class: 'dk-dim', style: 'font-size:11px;margin-top:5px', text: s.note }),
    ]))));

  const actions = h('div', { class: 'dk-row' });

  if (data.call) {
    actions.appendChild(h('button', { class: 'dk-btn ghost', text: 'SYNC FROM CARRIER', onclick: e => run(e.target, () => api.post(`/calls/${data.call.id}/sync`), { done: 'carrier record pulled' }) }));
    if (!['completed', 'failed'].includes(data.call.status)) {
      actions.appendChild(h('button', { class: 'dk-btn warn', text: 'HANG UP', onclick: e => run(e.target, () => api.post(`/calls/${data.call.id}/hangup`), { done: 'hung up' }) }));
    }
  }

  for (const rec of data.recordings) {
    const hasText = data.transcriptions.some(t => t.recordingId === rec.id && t.text);
    if (!hasText) {
      actions.appendChild(h('button', { class: 'dk-btn dark', text: `TRANSCRIBE ${fmt.span(rec.durationSeconds)}`, onclick: e => run(e.target, () => api.post(`/recordings/${rec.id}/transcribe`, {}), { done: 'transcribed' }) }));
    }
  }

  if (data.transcriptions.some(t => t.text) && !data.lead) {
    const textTrans = data.transcriptions.find(t => t.text);
    actions.appendChild(h('button', { class: 'dk-btn', text: 'DESIGN THE ITINERARY', onclick: e => run(e.target, () => api.post('/leads/generate', { callId: data.call?.id || undefined, transcriptionId: textTrans?.id }), { done: 'itinerary written' }) }));
  }

  if (data.lead && ['draft', 'pending_approval'].includes(data.lead.status)) {
    actions.appendChild(h('button', { class: 'dk-btn', text: 'APPROVE', onclick: e => run(e.target, () => api.post(`/leads/${data.lead.id}/approve`, { by: 'Holiday desk' }), { done: 'approved' }) }));
    actions.appendChild(h('button', { class: 'dk-btn ghost', text: 'SEND BACK WITH NOTES', onclick: () => reviseForm(data.lead) }));
  }
  if (data.lead && data.lead.status === 'approved') {
    actions.appendChild(h('button', { class: 'dk-btn', text: 'MAIL THE GUEST + SUPPLIER', onclick: () => sendForm(data.lead) }));
  }
  if (data.lead) {
    actions.appendChild(h('button', { class: 'dk-btn ghost', text: 'OPEN IN DESIGN', onclick: () => openDesk('design', { id: data.lead.id }) }));
    actions.appendChild(h('a', { class: 'dk-btn ghost', href: `/api/leads/${data.lead.id}/pdf?type=customer`, target: '_blank', style: 'display:inline-flex;align-items:center;text-decoration:none', text: 'ITINERARY PDF' }));
  }
  card.appendChild(actions);

  if (data.call) {
    card.appendChild(h('div', { class: 'dk-sep' }));
    card.appendChild(h('dl', { class: 'dk-kv' }, [
      h('dt', { text: 'Call' }), h('dd', { class: 'dk-mono', text: `${data.call.direction} · ${data.call.status} · ${fmt.span(data.call.durationSeconds)}` }),
      h('dt', { text: 'From → To' }), h('dd', { class: 'dk-mono', text: `${fmt.phone(data.call.from)} → ${fmt.phone(data.call.to)}` }),
      h('dt', { text: 'Started' }), h('dd', { text: fmt.when(data.call.startedAt) }),
      h('dt', { text: 'Carrier uuid' }), h('dd', { class: 'dk-mono', text: data.call.plivoCallUuid || '—' }),
    ]));
  }

  if (data.recordings.length) {
    card.appendChild(h('div', { class: 'dk-sep' }));
    card.appendChild(h('h3', { text: 'RECORDINGS' }));
    card.appendChild(table([
      { label: 'Length', cell: r => fmt.span(r.durationSeconds) },
      { label: 'Status', cell: r => h('span', { class: 'chip', text: r.status }) },
      { label: 'Audio', cell: r => h('audio', { controls: true, preload: 'none', src: r.playUrl }) },
    ], data.recordings));
  }

  const withText = data.transcriptions.filter(t => t.text);
  if (withText.length) {
    card.appendChild(h('div', { class: 'dk-sep' }));
    card.appendChild(h('h3', { text: 'WHAT WAS SAID' }));
    for (const t of withText.slice(0, 3)) {
      card.appendChild(h('div', { class: 'dk-row', style: 'margin-bottom:6px' }, [
        h('span', { class: 'chip', text: t.language || 'auto' }),
        h('span', { class: 'dk-dim', text: `${t.wordCount || 0} words · ${t.source}` }),
      ]));
      card.appendChild(h('div', { class: 'doc', text: t.text }));
    }
  }

  if (data.lead) {
    card.appendChild(h('div', { class: 'dk-sep' }));
    card.appendChild(h('h3', { text: `ITINERARY · ${data.lead.title}` }));
    card.appendChild(h('div', { class: 'dk-row', style: 'margin-bottom:8px' }, [
      statusChip(data.lead.status),
      data.lead.revisionNotes ? h('span', { class: 'chip', text: 'revised' }) : null,
      h('span', { class: 'dk-dim', text: fmt.when(data.lead.updatedAt) }),
    ]));
    card.appendChild(h('div', { class: 'doc', text: data.lead.itinerary }));
  }

  return card;
}

/* CALL DESK --------------------------------------------------------------- */
PANELS.calls = async params => {
  const [list, contacts] = await Promise.all([api.get('/calls'), api.get('/contacts')]);
  const wrap = h('div');

  const contactSelect = h('select', { class: 'dk-sel' }, [
    h('option', { value: '' }, ['— pick a contact —']),
    ...contacts.contacts.map(c => h('option', { value: c.id }, [`${c.name} · ${c.phone}`])),
  ]);
  const numberInput = h('input', { class: 'dk-in', placeholder: 'or type a number (+91…)', style: 'min-width:190px' });
  const modeSelect = h('select', { class: 'dk-sel' }, [
    h('option', { value: 'message' }, ['message (greet + record)']),
    h('option', { value: 'browser' }, ['talk from this browser']),
  ]);

  if (params.contactId) contactSelect.value = params.contactId;
  if (params.to) numberInput.value = params.to;

  const dial = h('button', {
    class: 'dk-btn', text: 'DIAL',
    onclick: e => run(e.target, async () => {
      const contactId = contactSelect.value;
      const to = numberInput.value.trim();
      if (!contactId && !to) throw new Error('pick a contact or type a number');
      return api.post('/calls', { contactId: contactId || undefined, to: to || undefined, mode: modeSelect.value });
    }, { done: 'dialling — Plivo will post the call back here' }),
  });

  wrap.appendChild(h('div', { class: 'dk-card', style: 'margin-bottom:16px' }, [
    h('h3', { text: 'PLACE A CALL' }),
    h('div', { class: 'dk-bar', style: 'margin:0' }, [contactSelect, h('span', { class: 'dk-dim', text: 'or' }), numberInput, modeSelect, dial]),
    h('div', { class: 'dk-note', text: 'The call is answered with this office\u2019s own XML, recorded by Plivo, and the recording is filed automatically — then transcribed, designed and approved in turn.' }),
  ]));

  wrap.appendChild(table([
    { label: 'Created', cell: c => when(c.createdAt) },
    { label: 'Called', cell: c => when(c.startedAt) },
    { label: 'Guest', cell: c => h('div', {}, [
      h('div', { class: 'dk-strong', text: c.contactName || fmt.phone(c.direction === 'outbound' ? c.to : c.from) }),
      h('div', { class: 'dk-mono dk-dim', text: `${c.direction} · ${fmt.phone(c.from)} → ${fmt.phone(c.to)}` }),
    ]) },
    { label: 'Status', cell: c => h('span', { class: 'chip', text: fmt.status(c.status) }) },
    { label: 'Length', cell: c => h('span', { class: 'dk-mono', text: fmt.span(c.durationSeconds) }) },
    { label: 'Rail', cell: c => h('span', { class: 'dk-dim', text: `${c.recordingCount} rec · ${c.transcriptCount} text${c.leadStatus ? ` · ${fmt.status(c.leadStatus)}` : ''}` }) },
    { label: '', cell: c => {
      const active = !['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(c.status);
      return h('div', { class: 'dk-row' }, [
        active ? h('button', { class: 'dk-btn sm warn', text: 'HANG UP', onclick: e => run(e.target, () => api.post(`/calls/${c.id}/hangup`), { done: 'hung up' }) }) : null,
        h('button', { class: 'dk-btn sm ghost', text: 'SYNC', onclick: e => run(e.target, () => api.post(`/calls/${c.id}/sync`), { done: 'carrier record pulled' }) }),
        h('button', { class: 'dk-btn sm', text: 'OPEN', onclick: () => openDesk('pipeline', { id: c.id }) }),
      ]);
    } },
  ], list.calls, { empty: 'No calls on file yet.' }));

  return wrap;
};

/* DESK PHONE -------------------------------------------------------------- */
PANELS.phone = async () => {
  const status = await api.get('/plivo/status');
  const wrap = h('div', { class: 'dk-grid' });

  wrap.appendChild(h('div', { class: 'dk-card' }, [
    h('h3', { text: 'THE LINE' }),
    h('dl', { class: 'dk-kv' }, [
      h('dt', { text: 'Plivo' }), h('dd', { text: status.configured ? 'configured' : 'not configured' }),
      h('dt', { text: 'Caller id' }), h('dd', { class: 'dk-mono', text: status.callerId || '—' }),
      h('dt', { text: 'SIP endpoint' }), h('dd', { class: 'dk-mono', text: status.username || 'none on the account' }),
      h('dt', { text: 'Credits' }), h('dd', { text: status.account ? `${status.account.credits} ${status.account.currency}` : '—' }),
      h('dt', { text: 'Webhook' }), h('dd', { text: status.webhook?.ok ? 'reachable' : (status.webhook?.reason || 'not reachable') }),
      h('dt', { text: 'Answer URL' }), h('dd', { class: 'dk-mono', text: status.webhook?.answerUrl || '—' }),
    ]),
    h('div', { class: 'dk-sep' }),
    h('div', { class: 'dk-row' }, [
      h('button', { class: 'dk-btn', text: 'OPEN THE DESK PHONE', onclick: () => { deps.softphone?.open?.(); } }),
      h('button', { class: 'dk-btn ghost', text: 'TEST THE ACCOUNT', onclick: e => run(e.target, async () => {
        const out = await api.get('/plivo/status');
        if (!out.configured) throw new Error('Plivo is not configured');
        if (out.error) throw new Error(out.error);
        return out;
      }, { refresh: false, done: 'the Plivo account answered' }) }),
    ]),
  ]));

  wrap.appendChild(h('div', { class: 'dk-card' }, [
    h('h3', { text: 'HOW A CALL IS TAKEN' }),
    h('div', { class: 'dk-note', text: 'Plivo fetches this office\u2019s answer URL when the guest picks up. In browser mode the call is bridged to the SIP endpoint registered above, and both legs are recorded; in message mode the guest is greeted and their brief is recorded. Either way the recording is posted back to /api/webhooks/plivo/record and filed automatically.' }),
  ]));

  return wrap;
};

/* NUMBERS ----------------------------------------------------------------- */
PANELS.numbers = async () => {
  const data = await api.get('/numbers');
  const wrap = h('div');

  wrap.appendChild(h('div', { class: 'dk-bar' }, [
    h('button', { class: 'dk-btn', text: '+ SEARCH & BUY A NUMBER', onclick: () => searchForm() }),
    h('span', { class: 'sp' }),
    h('span', { class: 'dk-dim', text: `caller id: ${data.callerId || '—'} · webhook: ${data.webhook.base || 'not set'}` }),
  ]));

  wrap.appendChild(table([
    { label: 'Added', cell: n => when(n.createdAt) },
    { label: 'Number', cell: n => h('span', { class: 'dk-mono dk-strong', text: n.e164 }) },
    { label: 'Name', cell: n => n.friendlyName || '—' },
    { label: 'Country', cell: n => n.countryIso || '—' },
    { label: 'Status', cell: n => h('span', { class: 'chip', text: n.status }) },
    { label: 'Record', cell: n => h('span', { class: 'chip', text: n.recordCalls ? 'on' : 'off' }) },
    { label: 'Calls', cell: n => String(n.callCount) },
    { label: '', cell: n => h('div', { class: 'dk-row' }, [
      h('button', { class: 'dk-btn sm ghost', text: n.recordCalls ? 'RECORD OFF' : 'RECORD ON', onclick: e => run(e.target, () => api.patch(`/numbers/${n.id}`, { recordCalls: !n.recordCalls }), { done: 'number updated' }) }),
      n.status === 'active' ? h('button', { class: 'dk-btn sm warn', text: 'RELEASE', onclick: e => {
        if (!confirm(`Release ${n.e164} back to Plivo? Calls to it will stop working.`)) return;
        run(e.target, () => api.del(`/numbers/${n.id}`), { done: 'number released' });
      } }) : null,
    ]) },
  ], data.numbers, { empty: 'No numbers on file. Search Plivo\u2019s inventory to buy one.' }));

  return wrap;
};

function searchForm() {
  const country = h('input', { class: 'dk-in', value: 'IN', placeholder: 'IN' });
  const type = h('select', { class: 'dk-sel' }, ['local', 'tollfree', 'mobile'].map(t => h('option', { value: t }, [t])));
  const pattern = h('input', { class: 'dk-in', placeholder: 'e.g. 80' });
  const results = h('div');

  const modal = h('div', { class: 'dk-modal' }, [h('div', { class: 'dk-sheet' }, [
    h('h3', { text: 'FIND A NUMBER' }),
    h('div', { style: 'padding:16px 18px' }, [
      h('div', { class: 'dk-row' }, [country, type, pattern, h('button', {
        class: 'dk-btn', text: 'SEARCH',
        onclick: async e => {
          const btn = e.target;
          btn.disabled = true;
          try {
            results.innerHTML = '';
            results.appendChild(h('div', { class: 'dk-empty', text: 'asking Plivo…' }));
            const out = await api.get(`/numbers/search?countryIso=${encodeURIComponent(country.value)}&type=${encodeURIComponent(type.value)}&pattern=${encodeURIComponent(pattern.value)}`);
            results.innerHTML = '';
            results.appendChild(table([
              { label: 'Number', cell: n => h('span', { class: 'dk-mono', text: n.number }) },
              { label: 'Region', cell: n => [n.city, n.region].filter(Boolean).join(', ') || '—' },
              { label: 'Rental', cell: n => n.monthlyRental ? String(n.monthlyRental) : '—' },
              { label: '', cell: n => h('button', { class: 'dk-btn sm', text: 'BUY', onclick: e2 => {
                if (!confirm(`Buy ${n.number}? Plivo will start charging the monthly rental.`)) return;
                run(e2.target, () => api.post('/numbers/buy', { number: n.number, countryIso: country.value, type: type.value }), { refresh: false, done: 'number bought' })
                  .then(() => { modal.remove(); render(currentDesk, currentParams); });
              } }) },
            ], out.available, { empty: 'Plivo has nothing matching that.' }));
          } catch (err) {
            results.innerHTML = '';
            results.appendChild(h('div', { class: 'dk-err', text: err.message }));
          } finally { btn.disabled = false; }
        },
      })]),
      results,
      h('div', { class: 'dk-foot' }, [h('button', { class: 'dk-btn ghost', text: 'CLOSE', onclick: () => modal.remove() })]),
    ]),
  ])]);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  overlay.querySelector('.dk-panel').appendChild(modal);
}

/* RECORDINGS -------------------------------------------------------------- */
PANELS.recordings = async params => {
  const search = params.search || '';
  const data = await api.get(`/recordings?limit=150${search ? `&search=${encodeURIComponent(search)}` : ''}`);
  const wrap = h('div');

  wrap.appendChild(h('div', { class: 'dk-bar' }, [
    h('input', { class: 'dk-in', value: search, placeholder: 'search by guest…', style: 'min-width:200px', onkeydown: e => { if (e.key === 'Enter') openDesk('recordings', { search: e.target.value }); } }),
    h('button', { class: 'dk-btn ghost', text: 'SYNC FROM CARRIER', onclick: e => run(e.target, async () => {
      const calls = await api.get('/calls?limit=5');
      const recent = calls.calls.find(c => c.status === 'completed') || calls.calls[0];
      if (!recent) throw new Error('no calls to sync');
      return api.post(`/recordings/sync/${recent.id}`);
    }, { done: 'carrier checked' }) }),
    h('span', { class: 'sp' }),
    h('span', { class: 'dk-dim', text: `${data.totals.total} recordings · ${data.totals.notTranscribed} not transcribed · ${fmt.span(data.totals.seconds)} of audio` }),
  ]));

  wrap.appendChild(table([
    { label: 'Created', cell: r => when(r.createdAt) },
    { label: 'Call', cell: r => when(r.callStartedAt) },
    { label: 'Guest', cell: r => h('div', {}, [
      h('div', { class: 'dk-strong', text: r.contactName || fmt.phone(r.direction === 'outbound' ? r.to : r.from) || '—' }),
      h('div', { class: 'dk-dim dk-mono', text: r.plivoRecordingId?.slice(0, 8) }),
    ]) },
    { label: 'Length', cell: r => h('span', { class: 'dk-mono', text: fmt.span(r.durationSeconds) }) },
    { label: 'Audio', cell: r => h('audio', { controls: true, preload: 'none', src: r.playUrl }) },
    { label: 'Text', cell: r => r.transcriptWords ? h('span', { class: 'chip done', text: `${r.transcriptWords} words` }) : h('span', { class: 'chip waiting', text: 'not transcribed' }) },
    { label: '', cell: r => h('div', { class: 'dk-row' }, [
      h('button', {
        class: 'dk-btn sm', text: r.transcriptionId ? 'RE-TRANSCRIBE' : 'TRANSCRIBE',
        onclick: e => run(e.target, () => api.post(`/recordings/${r.id}/transcribe`, {}), { done: 'transcribed' }),
      }),
      h('button', { class: 'dk-btn sm ghost', text: 'OPEN CALL', onclick: () => openDesk('pipeline', { id: r.callId }) }),
    ]) },
  ], data.recordings, { empty: 'No recordings yet — they arrive when Plivo finishes a call.' }));

  return wrap;
};

/* TRANSCRIPTS ------------------------------------------------------------- */
PANELS.transcriptions = async params => {
  const data = await api.get('/transcriptions?limit=150');
  const wrap = h('div', { class: 'dk-grid' });

  const list = table([
    { label: 'Created', cell: t => when(t.createdAt) },
    { label: 'Guest', cell: t => h('span', { class: 'dk-strong', text: t.contactName || fmt.phone(t.to || t.from) }) },
    { label: 'Words', cell: t => String(t.wordCount || 0) },
    { label: 'Lang', cell: t => h('span', { class: 'chip', text: t.language || '—' }) },
    { label: '', cell: t => h('button', { class: 'dk-btn sm ghost', text: 'READ', onclick: () => openDesk('transcriptions', { id: t.id }) }) },
  ], data.transcriptions, { empty: 'Nothing transcribed yet — open the RECORDING VAULT and transcribe a call.' });

  const detail = h('div', { class: 'dk-card' });
  const chosen = params.id
    ? data.transcriptions.find(t => t.id === params.id) || await api.get(`/transcriptions/${params.id}`).then(r => r.transcription).catch(() => null)
    : data.transcriptions.find(t => t.text);

  if (chosen) {
    detail.appendChild(h('h3', { text: `TRANSCRIPT · ${chosen.contactName || fmt.phone(chosen.to || chosen.from)}` }));
    detail.appendChild(h('div', { class: 'dk-row', style: 'margin-bottom:8px' }, [
      h('span', { class: 'chip', text: chosen.language || 'auto' }),
      h('span', { class: 'chip', text: chosen.source }),
      h('span', { class: 'dk-dim', text: `${chosen.wordCount || 0} words · ${fmt.when(chosen.createdAt)}` }),
    ]));
    detail.appendChild(h('div', { class: 'doc', text: chosen.text || '(empty)' }));
    detail.appendChild(h('div', { class: 'dk-sep' }));
    detail.appendChild(h('div', { class: 'dk-row' }, [
      (chosen.callId || chosen.id) ? h('button', { class: 'dk-btn', text: 'DESIGN THE ITINERARY', onclick: e => run(e.target, () => api.post('/leads/generate', { callId: chosen.callId || undefined, transcriptionId: chosen.id }), { done: 'itinerary written' }).then(out => openDesk('design', { id: out?.lead?.id })) }) : null,
      chosen.recordingId ? h('button', { class: 'dk-btn ghost', text: 'RE-TRANSCRIBE', onclick: e => run(e.target, () => api.post(`/recordings/${chosen.recordingId}/transcribe`, {}), { done: 'transcribed' }) }) : null,
    ]));
  } else {
    detail.appendChild(h('div', { class: 'dk-empty', text: 'Pick a transcript to read.' }));
  }

  wrap.appendChild(list);
  wrap.appendChild(detail);
  return wrap;
};

/* TRIP DESIGN (leads) ----------------------------------------------------- */
PANELS.leads = async params => {
  const [leads, calls] = await Promise.all([api.get('/leads'), api.get('/calls?limit=40')]);
  const wrap = h('div');

  const transcribable = calls.calls.filter(c => c.transcriptCount > 0);
  const callSelect = h('select', { class: 'dk-sel' }, [
    h('option', { value: '' }, ['— pick a transcribed call —']),
    ...transcribable.map(c => h('option', { value: c.id }, [`${fmt.when(c.startedAt)} · ${c.contactName || fmt.phone(c.to || c.from)}${c.leadId ? ' (has trip)' : ''}`])),
  ]);

  wrap.appendChild(h('div', { class: 'dk-card', style: 'margin-bottom:16px' }, [
    h('h3', { text: 'DESIGN FROM A CALL' }),
    h('div', { class: 'dk-bar', style: 'margin:0' }, [
      callSelect,
      h('button', { class: 'dk-btn', text: 'WRITE THE ITINERARY', onclick: e => run(e.target, async () => {
        if (!callSelect.value) throw new Error('pick a call first');
        const out = await api.post('/leads/generate', { callId: callSelect.value });
        if (out?.lead?.id) openDesk('design', { id: out.lead.id });
        return out;
      }, { done: 'the itinerary is written and waiting for approval' }) }),
      h('span', { class: 'sp' }),
      h('button', { class: 'dk-btn ghost', text: '+ BLANK LEAD', onclick: () => leadForm() }),
    ]),
    h('div', { class: 'dk-note', text: leads.providers.itinerary ? 'The designer reads the transcript and returns the trip document.' : 'No model key configured — the designer will fall back to a template.' }),
  ]));

  wrap.appendChild(table([
    { label: 'Created', cell: l => when(l.createdAt) },
    { label: 'Updated', cell: l => when(l.updatedAt) },
    { label: 'Trip', cell: l => h('div', {}, [
      h('div', { class: 'dk-strong', text: l.title }),
      h('div', { class: 'dk-dim', text: [l.destination, l.contactName].filter(Boolean).join(' · ') || '—' }),
    ]) },
    { label: 'Status', cell: l => statusChip(l.status) },
    { label: 'Rail', cell: l => h('span', { class: 'dk-dim', text: `${l.recordingCount} rec · ${l.transcriptCount} text` }) },
    { label: '', cell: l => h('div', { class: 'dk-row' }, [
      h('button', { class: 'dk-btn sm', text: 'OPEN', onclick: () => openDesk('design', { id: l.id }) }),
      h('a', { class: 'dk-btn sm ghost', href: `/api/leads/${l.id}/pdf?type=customer`, target: '_blank', style: 'display:inline-flex;align-items:center;text-decoration:none', text: 'PDF' }),
    ]) },
  ], leads.leads, { empty: 'No trips designed yet.' }));

  if (params.id) wrap.appendChild(await leadCard(params.id));
  return wrap;
};

async function leadCard(id) {
  const data = await api.get(`/leads/${id}`);
  const lead = data.lead;
  const card = h('div', { class: 'dk-card', style: 'margin-top:16px' });

  card.appendChild(h('h3', { text: lead.title }));
  card.appendChild(h('div', { class: 'dk-row', style: 'margin-bottom:10px' }, [
    statusChip(lead.status),
    h('span', { class: 'dk-dim', text: lead.destination || '—' }),
    h('span', { class: 'dk-dim', text: lead.contactName ? `· ${lead.contactName}` : '' }),
    h('span', { class: 'dk-when', text: `created ${fmt.when(lead.createdAt)} · updated ${fmt.when(lead.updatedAt)}` }),
  ]));

  if (lead.qualification && Object.keys(lead.qualification).length) {
    const q = lead.qualification;
    card.appendChild(h('div', { class: 'dk-row', style: 'margin:8px 0 10px;gap:8px' }, [
      h('div', { class: 'dk-card', style: 'padding:5px 9px;font-size:11px' }, [
        h('span', { class: 'dk-dim', text: 'BUDGET: ' }),
        h('span', { class: 'dk-strong', text: String(q.estimatedBudget || 'On Request') }),
      ]),
      h('div', { class: 'dk-card', style: 'padding:5px 9px;font-size:11px' }, [
        h('span', { class: 'dk-dim', text: 'DATES: ' }),
        h('span', { class: 'dk-strong', text: String(q.travelDates || 'Upcoming') }),
      ]),
      h('div', { class: 'dk-card', style: 'padding:5px 9px;font-size:11px' }, [
        h('span', { class: 'dk-dim', text: 'PAX: ' }),
        h('span', { class: 'dk-strong', text: String(q.numberOfTravelers || 2) }),
      ]),
      h('div', { class: 'dk-card', style: 'padding:5px 9px;font-size:11px' }, [
        h('span', { class: 'dk-dim', text: 'STYLE: ' }),
        h('span', { class: 'dk-strong', text: String(q.travelStyle || 'Bespoke') }),
      ]),
    ]));
  }

  if (lead.pricing && (lead.pricing.finalSellingPrice || lead.pricing.totalPrice)) {
    const p = lead.pricing;
    card.appendChild(h('div', { class: 'dk-row', style: 'margin:4px 0 10px;gap:8px' }, [
      h('div', { class: 'dk-card', style: 'padding:7px 11px;background:#FEF9EE;border-color:#FDE68A' }, [
        h('div', { class: 'dk-dim', style: 'font-size:9.5px', text: 'CALCULATED SELLING PRICE' }),
        h('div', { class: 'dk-strong', style: 'font-size:14px;color:#B45309', text: `${p.currency || 'INR'} ${Number(p.finalSellingPrice || p.totalPrice).toLocaleString('en-IN')}` }),
        h('div', { class: 'dk-dim', style: 'font-size:10.5px', text: `Cost: ${p.currency || 'INR'} ${Number(p.supplierCost || 0).toLocaleString('en-IN')} (+${p.staffMarginPercent || 10}% margin)` }),
      ]),
    ]));
  }

  card.appendChild(h('div', { class: 'dk-row', style: 'margin-bottom:12px;flex-wrap:wrap;gap:6px' }, [
    h('button', { class: 'dk-btn ghost', text: 'EDIT', onclick: () => leadForm(lead) }),
    h('button', { class: 'dk-btn', text: 'QUOTES & PRICING', onclick: () => openDesk('quotes', { leadId: lead.id }) }),
    h('button', { class: 'dk-btn ghost', text: 'FOLLOW-UPS', onclick: () => openDesk('followups', { leadId: lead.id }) }),
    ['draft', 'pending_approval'].includes(lead.status) ? h('button', { class: 'dk-btn', text: 'APPROVE', onclick: e => run(e.target, () => api.post(`/leads/${lead.id}/approve`, { by: 'Holiday desk' }), { done: 'approved' }) }) : null,
    ['draft', 'pending_approval'].includes(lead.status) ? h('button', { class: 'dk-btn ghost', text: 'SEND BACK', onclick: () => reviseForm(lead) }) : null,
    h('button', { class: 'dk-btn ghost', text: 'MAIL & WHATSAPP', onclick: () => sendForm(lead) }),
    ['approved', 'quote_sent'].includes(lead.status) ? h('button', { class: 'dk-btn', text: 'BOOKING HANDOVER', onclick: () => openDesk('bookings') }) : null,
    ['approved', 'quote_sent', 'sent_to_customer', 'sent_to_supplier', 'converted'].includes(lead.status) ? h('button', { class: 'dk-btn', text: 'DESPATCH', onclick: () => openDesk('despatch') }) : null,
    h('a', { class: 'dk-btn ghost', href: `/api/leads/${lead.id}/pdf?type=customer`, target: '_blank', style: 'display:inline-flex;align-items:center;text-decoration:none', text: 'CUSTOMER PDF' }),
    h('a', { class: 'dk-btn ghost', href: `/api/leads/${lead.id}/pdf?type=supplier`, target: '_blank', style: 'display:inline-flex;align-items:center;text-decoration:none', text: 'SUPPLIER PDF' }),
    h('button', { class: 'dk-btn warn', text: 'DELETE', onclick: e => { if (confirm('Delete this lead?')) run(e.target, () => api.del(`/leads/${lead.id}`), { done: 'lead deleted' }).then(() => openDesk('design')); } }),
  ]));

  if (lead.revisionNotes) card.appendChild(h('div', { class: 'dk-note', text: `Staff notes: ${lead.revisionNotes}` }));
  card.appendChild(h('div', { class: 'doc', text: lead.itinerary }));

  if (data.transcriptions?.length) {
    card.appendChild(h('div', { class: 'dk-sep' }));
    card.appendChild(h('h3', { text: 'FROM THE CALL' }));
    card.appendChild(h('div', { class: 'doc', text: data.transcriptions[0].text }));
  }

  if (data.trail?.length) {
    card.appendChild(h('div', { class: 'dk-sep' }));
    card.appendChild(h('h3', { text: 'TRAIL' }));
    card.appendChild(table([
      { label: 'Created', cell: t => when(t.createdAt) },
      { label: 'Action', cell: t => h('span', { class: 'dk-mono', text: t.action }) },
      { label: 'Result', cell: t => h('span', { class: `chip ${t.result === 'success' ? 'done' : 'blocked'}`, text: t.result }) },
    ], data.trail));
  }
  return card;
}

function leadForm(lead = null) {
  openForm({
    title: lead ? 'EDIT THE TRIP' : 'NEW LEAD',
    submitLabel: lead ? 'SAVE' : 'CREATE',
    fields: [
      field('title', 'Title', { value: lead?.title || '', required: true, placeholder: 'Bespoke 6-day Kerala family trip' }),
      field('destination', 'Destination', { value: lead?.destination || '', placeholder: 'Kerala, India' }),
      field('customerEmail', 'Guest email', { value: lead?.customerEmail || lead?.contactEmail || '', placeholder: 'guest@example.com' }),
      field('itinerary', 'Itinerary (markdown)', { type: 'textarea', value: lead?.itinerary || '' }),
    ],
    onSubmit: values => (lead ? api.put(`/leads/${lead.id}`, values) : api.post('/leads', values)),
  });
}

function reviseForm(lead) {
  openForm({
    title: `SEND BACK · ${lead.title}`,
    submitLabel: 'REWORK IT',
    hint: 'The designer reworks the document from these notes, archives a new version snapshot, and the lead returns to the approval gate.',
    fields: [field('correctionNotes', 'What needs to change', { type: 'textarea', required: true, placeholder: '5 nights not 6, add a cooking class, drop the sunset cruise' })],
    onSubmit: values => api.post(`/leads/${lead.id}/revise`, values),
  });
}

function sendForm(lead) {
  api.get('/suppliers').then(({ suppliers }) => {
    openForm({
      title: `DISPATCH QUOTATION · ${lead.title}`,
      submitLabel: 'SEND VIA EMAIL & WHATSAPP',
      hint: 'The guest receives the final quotation on WhatsApp and Email simultaneously. Follow-up automations are scheduled automatically.',
      fields: [
        field('customerEmail', 'Guest email', { value: lead.customerEmail || lead.contactEmail || '', required: true }),
        field('customerPhone', 'Guest WhatsApp / Mobile', { value: lead.contactPhone || '' }),
        field('supplierId', 'Supplier for the RFQ', {
          type: 'select',
          options: [{ value: '', label: '— none (guest only) —' }, ...suppliers.map(s => ({ value: s.id, label: `${s.name} · ${s.email}` }))],
          value: lead.selectedSupplierId || '',
        }),
      ],
      onSubmit: values => api.post(`/leads/${lead.id}/send`, values),
    });
  }).catch(e => toast(e.message, 'bad'));
}

/* REVISIONS & VERSIONS (Module 3, Slide 8) -------------------------------- */
PANELS.revisions = async params => {
  const [data, versionsData] = await Promise.all([
    api.get('/leads'),
    params.leadId ? api.get(`/versions?leadId=${encodeURIComponent(params.leadId)}`) : Promise.resolve({ versions: [] }),
  ]);
  const rows = data.leads.filter(l => l.revisionNotes || l.versionsCount > 0);
  const wrap = h('div');

  if (params.leadId && versionsData.versions.length) {
    wrap.appendChild(h('div', { class: 'dk-bar' }, [
      h('span', { class: 'dk-strong', text: `HISTORICAL VERSIONS (${versionsData.versions.length} SNAPSHOTS)` }),
      h('span', { class: 'sp' }),
      h('button', { class: 'dk-btn sm ghost', text: '◂ ALL REVISIONS', onclick: () => openDesk('revisions') }),
    ]));
    wrap.appendChild(table([
      { label: 'Version', cell: v => h('span', { class: 'chip done', text: `v${v.versionNumber}` }) },
      { label: 'Date', cell: v => when(v.createdAt) },
      { label: 'Author', cell: v => h('span', { class: 'dk-dim', text: v.author }) },
      { label: 'Notes / Change Reason', cell: v => h('span', { class: 'dk-strong', text: v.notes || '—' }) },
      { label: 'Selling Price', cell: v => h('span', { class: 'dk-mono', text: v.price ? `${v.currency || 'INR'} ${Number(v.price).toLocaleString('en-IN')}` : '—' }) },
      { label: '', cell: v => h('button', {
        class: 'dk-btn sm', text: 'RESTORE THIS VERSION',
        onclick: e => run(e.target, () => api.post(`/versions/${v.id}/restore`, {}), { done: `Restored v${v.versionNumber}` }).then(() => openDesk('design', { id: v.leadId })),
      }) },
    ], versionsData.versions));
    wrap.appendChild(h('div', { class: 'dk-sep' }));
  }

  wrap.appendChild(h('div', { class: 'dk-bar' }, [
    h('span', { class: 'dk-dim', text: `${rows.length} trip(s) with rework notes or versions on file.` }),
  ]));

  wrap.appendChild(table([
    { label: 'Created', cell: l => when(l.createdAt) },
    { label: 'Updated', cell: l => when(l.updatedAt) },
    { label: 'Trip', cell: l => h('span', { class: 'dk-strong', text: l.title }) },
    { label: 'Version', cell: l => h('span', { class: 'chip', text: `v${l.currentVersion || 1}` }) },
    { label: 'Staff Notes', cell: l => h('span', { class: 'dk-dim', text: l.revisionNotes || '—' }) },
    { label: 'Status', cell: l => statusChip(l.status) },
    { label: '', cell: l => h('div', { class: 'dk-row' }, [
      h('button', { class: 'dk-btn sm', text: 'OPEN', onclick: () => openDesk('leads', { id: l.id }) }),
      h('button', { class: 'dk-btn sm ghost', text: 'VERSIONS', onclick: () => openDesk('revisions', { leadId: l.id }) }),
      h('button', { class: 'dk-btn sm ghost', text: 'REWORK AGAIN', onclick: () => reviseForm(l) }),
    ]) },
  ], rows, { empty: 'Nothing has been sent back for rework.' }));

  return wrap;
};

/* APPROVAL GATE ----------------------------------------------------------- */
PANELS.approvals = async () => {
  const data = await api.get('/leads?status=pending_approval,draft');
  const wrap = h('div');

  wrap.appendChild(h('div', { class: 'dk-bar' }, [
    h('span', { class: 'dk-strong', text: `${data.leads.length} file(s) waiting` }),
    h('span', { class: 'sp' }),
    h('span', { class: 'dk-dim', text: 'Nothing is mailed until a person signs it off.' }),
  ]));

  if (!data.leads.length) {
    wrap.appendChild(h('div', { class: 'dk-empty', text: 'Nothing is waiting for approval.' }));
    return wrap;
  }

  for (const lead of data.leads) {
    const card = h('div', { class: 'dk-card', style: 'margin-bottom:14px' });
    card.appendChild(h('div', { class: 'dk-row' }, [
      h('div', { style: 'flex:1' }, [
        h('div', { class: 'dk-strong', text: lead.title }),
        h('div', { class: 'dk-dim', text: [lead.destination, lead.contactName].filter(Boolean).join(' · ') }),
        h('div', { class: 'dk-when', text: `created ${fmt.when(lead.createdAt)} · updated ${fmt.when(lead.updatedAt)}` }),
      ]),
      statusChip(lead.status),
    ]));
    card.appendChild(h('div', { class: 'dk-sep' }));

    // the actual document, trimmed: enough to judge it
    const lines = String(lead.itinerary || '').split('\n').slice(0, 22).join('\n');
    card.appendChild(h('div', { class: 'doc', style: 'max-height:230px', text: lines }));

    card.appendChild(h('div', { class: 'dk-row', style: 'margin-top:10px' }, [
      h('button', { class: 'dk-btn', text: '✓ APPROVE', onclick: e => run(e.target, () => api.post(`/leads/${lead.id}/approve`, { by: 'Holiday desk' }), { done: 'approved — ready to post' }) }),
      h('button', { class: 'dk-btn ghost', text: 'SEND BACK WITH NOTES', onclick: () => reviseForm(lead) }),
      h('button', { class: 'dk-btn warn', text: 'REJECT', onclick: () => openForm({
        title: 'REJECT',
        submitLabel: 'REJECT',
        fields: [field('reason', 'Why', { type: 'textarea', placeholder: 'budget too high, guest went elsewhere…' })],
        onSubmit: values => api.post(`/leads/${lead.id}/reject`, values),
      }) }),
      h('span', { class: 'sp' }),
      h('button', { class: 'dk-btn ghost', text: 'FULL FILE', onclick: () => openDesk('leads', { id: lead.id }) }),
      h('a', { class: 'dk-btn ghost', href: `/api/leads/${lead.id}/pdf?type=customer`, target: '_blank', style: 'display:inline-flex;align-items:center;text-decoration:none', text: 'PDF' }),
    ]));
    wrap.appendChild(card);
  }

  return wrap;
};

/* DESPATCH ---------------------------------------------------------------- */
PANELS.despatch = async () => {
  const data = await api.get('/leads');
  const sendable = data.leads.filter(l => ['approved', 'sent_to_customer', 'sent_to_supplier', 'converted'].includes(l.status));
  const wrap = h('div');

  wrap.appendChild(h('div', { class: 'dk-bar' }, [
    h('span', { class: 'dk-strong', text: `${sendable.length} approved or posted` }),
    h('span', { class: 'sp' }),
    h('span', { class: 'dk-dim', text: data.providers.mail ? 'Resend is configured — mail really leaves.' : 'No mail key: mails are composed and logged but not sent.' }),
  ]));

  wrap.appendChild(table([
    { label: 'Created', cell: l => when(l.createdAt) },
    { label: 'Trip', cell: l => h('div', {}, [
      h('div', { class: 'dk-strong', text: l.title }),
      h('div', { class: 'dk-dim', text: l.supplierName ? `supplier: ${l.supplierName}` : 'no supplier chosen' }),
    ]) },
    { label: 'Status', cell: l => statusChip(l.status) },
    { label: 'Guest mail', cell: l => l.customerSentAt ? h('span', { class: 'dk-dim', text: `${l.customerEmail || '—'} · ${fmt.when(l.customerSentAt)}` }) : h('span', { class: 'chip waiting', text: 'not sent' }) },
    { label: 'Supplier mail', cell: l => l.supplierSentAt ? h('span', { class: 'dk-dim', text: fmt.when(l.supplierSentAt) }) : h('span', { class: 'chip waiting', text: 'not sent' }) },
    { label: '', cell: l => h('div', { class: 'dk-row' }, [
      h('button', { class: 'dk-btn sm', text: 'MAIL', onclick: () => sendForm(l) }),
      h('button', { class: 'dk-btn sm ghost', text: 'PREVIEW', onclick: () => previewModal(l) }),
      h('button', { class: 'dk-btn sm ghost', text: 'OPEN', onclick: () => openDesk('design', { id: l.id }) }),
      h('a', { class: 'dk-btn sm ghost', href: `/api/leads/${l.id}/pdf?type=customer`, target: '_blank', style: 'display:inline-flex;align-items:center;text-decoration:none', text: 'PDF' }),
    ]) },
  ], sendable, { empty: 'Nothing approved to despatch yet. Sign a file off at the APPROVAL GATE.' }));

  return wrap;
};

function previewModal(lead) {
  api.get(`/leads/${lead.id}/preview`).then(p => {
    const modal = h('div', { class: 'dk-modal' }, [h('div', { class: 'dk-sheet' }, [
      h('h3', { text: 'WHAT WILL BE SENT' }),
      h('div', { style: 'padding:16px 18px' }, [
        h('dl', { class: 'dk-kv' }, [
          h('dt', { text: 'Guest to' }), h('dd', { class: 'dk-mono', text: p.customer.to }),
          h('dt', { text: 'Guest subject' }), h('dd', { text: p.customer.subject }),
          h('dt', { text: 'Supplier to' }), h('dd', { class: 'dk-mono', text: p.supplier.to }),
          h('dt', { text: 'Supplier subject' }), h('dd', { text: p.supplier.subject }),
        ]),
        h('div', { class: 'dk-note', style: 'margin:10px 0', text: p.ready ? 'Both mails have somewhere to go.' : 'One of the addresses is missing — add it before sending.' }),
        h('div', { class: 'doc', text: p.customer.lines.join('\n') }),
        h('div', { class: 'dk-foot' }, [h('button', { class: 'dk-btn ghost', text: 'CLOSE', onclick: () => modal.remove() })]),
      ]),
    ])]);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    overlay.querySelector('.dk-panel').appendChild(modal);
  }).catch(e => toast(e.message, 'bad'));
}

/* CONTACTS ---------------------------------------------------------------- */
PANELS.contacts = async params => {
  const search = params.search || '';
  const data = await api.get(`/contacts${search ? `?search=${encodeURIComponent(search)}` : ''}`);
  const wrap = h('div');

  wrap.appendChild(h('div', { class: 'dk-bar' }, [
    h('input', {
      class: 'dk-in', value: search, placeholder: 'search name, number, email…', style: 'min-width:220px',
      onkeydown: e => { if (e.key === 'Enter') openDesk('contacts', { search: e.target.value }); },
    }),
    h('button', { class: 'dk-btn', text: '+ ADD CONTACT', onclick: () => contactForm() }),
    h('span', { class: 'sp' }),
    h('span', { class: 'dk-dim', text: `${data.contacts.length} contacts` }),
  ]));

  const callContact = async (contact, button) => run(button, async () => {
    const call = await api.post('/calls', { contactId: contact.id, mode: 'message' });
    return call;
  }, { done: 'dialling — watch the CALL DESK' }).then(() => openDesk('calls'));

  wrap.appendChild(table([
    { label: 'Added', cell: c => when(c.createdAt) },
    { label: 'Name', cell: c => h('div', {}, [
      h('div', { class: 'dk-strong', text: c.name }),
      h('div', { class: 'dk-dim', text: c.company || '—' }),
    ]) },
    { label: 'Phone', cell: c => h('span', { class: 'dk-mono', text: fmt.phone(c.phone) }) },
    { label: 'Email', cell: c => c.email ? h('span', { class: 'dk-mono', text: c.email }) : h('span', { class: 'chip waiting', text: 'no email' }) },
    { label: 'History', cell: c => h('span', { class: 'dk-dim', text: `${c.callCount} call(s) · ${c.leadCount} lead(s)` }) },
    { label: '', cell: c => h('div', { class: 'dk-row' }, [
      h('button', { class: 'dk-btn sm', text: 'CALL', onclick: e => callContact(c, e.target) }),
      h('button', { class: 'dk-btn sm ghost', text: 'EDIT', onclick: () => contactForm(c) }),
      h('button', { class: 'dk-btn sm warn', text: 'DELETE', onclick: e => { if (confirm(`Delete ${c.name}?`)) run(e.target, () => api.del(`/contacts/${c.id}`), { done: 'contact deleted' }); } }),
    ]) },
  ], data.contacts, { empty: 'No contacts yet — add the first one so the office has someone to call.' }));

  return wrap;
};

function contactForm(contact = null) {
  openForm({
    title: contact ? `EDIT · ${contact.name}` : 'ADD A CONTACT',
    submitLabel: contact ? 'SAVE' : 'ADD CONTACT',
    fields: [
      field('name', 'Name', { value: contact?.name || '', required: true, placeholder: 'Mehta family — Anil' }),
      field('phone', 'Phone', { value: contact?.phone || '', required: true, placeholder: '+919876543210' }),
      field('email', 'Email', { value: contact?.email || '', placeholder: 'guest@example.com' }),
      field('company', 'Company', { value: contact?.company || '' }),
      field('notes', 'Notes', { type: 'textarea', value: contact?.notes || '' }),
    ],
    onSubmit: values => (contact ? api.put(`/contacts/${contact.id}`, values) : api.post('/contacts', values)),
  });
}

/* SUPPLIERS --------------------------------------------------------------- */
PANELS.suppliers = async params => {
  const data = await api.get(`/suppliers${params.search ? `?search=${encodeURIComponent(params.search)}` : ''}`);
  const wrap = h('div');

  wrap.appendChild(h('div', { class: 'dk-bar' }, [
    h('input', {
      class: 'dk-in', value: params.search || '', placeholder: 'search suppliers…', style: 'min-width:200px',
      onkeydown: e => { if (e.key === 'Enter') openDesk('suppliers', { search: e.target.value }); },
    }),
    h('button', { class: 'dk-btn', text: '+ ADD SUPPLIER', onclick: () => supplierForm() }),
    h('span', { class: 'sp' }),
    h('span', { class: 'dk-dim', text: `${data.suppliers.length} partners` }),
  ]));

  wrap.appendChild(table([
    { label: 'Added', cell: s => when(s.createdAt) },
    { label: 'Name', cell: s => h('div', {}, [
      h('div', { class: 'dk-strong', text: s.name }),
      h('div', { class: 'dk-dim', text: s.contactPerson || '—' }),
    ]) },
    { label: 'Category', cell: s => h('span', { class: 'chip', text: s.category }) },
    { label: 'Email', cell: s => h('span', { class: 'dk-mono', text: s.email }) },
    { label: 'Phone', cell: s => h('span', { class: 'dk-mono', text: fmt.phone(s.phone) }) },
    { label: 'RFQs', cell: s => h('span', { class: 'dk-dim', text: `${s.quoteCount} sent` }) },
    { label: '', cell: s => h('div', { class: 'dk-row' }, [
      h('button', { class: 'dk-btn sm ghost', text: 'EDIT', onclick: () => supplierForm(s) }),
      h('button', { class: 'dk-btn sm warn', text: 'DELETE', onclick: e => { if (confirm(`Delete ${s.name}?`)) run(e.target, () => api.del(`/suppliers/${s.id}`), { done: 'supplier deleted' }); } }),
    ]) },
  ], data.suppliers, { empty: 'No suppliers yet.' }));

  return wrap;
};

function supplierForm(supplier = null) {
  api.get('/suppliers/categories').then(({ categories }) => {
    openForm({
      title: supplier ? `EDIT · ${supplier.name}` : 'ADD A SUPPLIER',
      submitLabel: supplier ? 'SAVE' : 'ADD SUPPLIER',
      fields: [
        field('name', 'Name', { value: supplier?.name || '', required: true, placeholder: 'Ocean Pearl Resorts' }),
        field('category', 'Category', { type: 'select', options: categories.map(c => ({ value: c, label: c })), value: supplier?.category || 'hotels' }),
        field('email', 'Email', { value: supplier?.email || '', required: true, placeholder: 'reservations@hotel.com' }),
        field('phone', 'Phone', { value: supplier?.phone || '' }),
        field('contactPerson', 'Contact person', { value: supplier?.contactPerson || '' }),
        field('notes', 'Notes', { type: 'textarea', value: supplier?.notes || '' }),
      ],
      onSubmit: values => (supplier ? api.put(`/suppliers/${supplier.id}`, values) : api.post('/suppliers', values)),
    });
  });
}

/* STAFF ------------------------------------------------------------------- */
PANELS.staff = async () => {
  const data = await api.get('/staff');
  const wrap = h('div');

  wrap.appendChild(h('div', { class: 'dk-bar' }, [
    h('button', { class: 'dk-btn', text: '+ ADD STAFF', onclick: () => staffForm() }),
    h('span', { class: 'sp' }),
    h('span', { class: 'dk-dim', text: `${data.staff.length} people on ${data.teams.length} team(s)` }),
  ]));

  wrap.appendChild(h('div', { class: 'dk-row', style: 'margin-bottom:14px' }, data.teams.map(t =>
    h('div', { class: 'dk-card', style: 'min-width:150px;padding:10px 12px' }, [
      h('div', { class: 'dk-strong', text: t.name.toUpperCase() }),
      h('div', { class: 'dk-dim', text: `${t.members} member(s)` }),
    ]))));

  wrap.appendChild(table([
    { label: 'Joined', cell: s => when(s.createdAt) },
    { label: 'Name', cell: s => h('div', {}, [
      h('div', { class: 'dk-strong', text: s.name }),
      h('div', { class: 'dk-mono dk-dim', text: s.email }),
    ]) },
    { label: 'Team', cell: s => h('span', { class: 'chip', text: s.role }) },
    { label: 'Status', cell: s => h('span', { class: 'chip', text: s.status }) },
    { label: 'Last seen', cell: s => when(s.lastLoginAt) },
    { label: '', cell: s => h('div', { class: 'dk-row' }, [
      h('button', { class: 'dk-btn sm ghost', text: 'EDIT', onclick: () => staffForm(s) }),
      h('button', { class: 'dk-btn sm warn', text: 'REMOVE', onclick: e => { if (confirm(`Remove ${s.name} from the office?`)) run(e.target, () => api.del(`/staff/${s.id}`), { done: 'removed' }); } }),
    ]) },
  ], data.staff, { empty: 'No staff on file.' }));

  return wrap;
};

function staffForm(person = null) {
  openForm({
    title: person ? `EDIT · ${person.name}` : 'ADD STAFF',
    submitLabel: person ? 'SAVE' : 'ADD TO THE TEAM',
    hint: 'The team is the role on the membership — owner, admin, reservations, operations, accounts, operator or viewer.',
    fields: [
      field('name', 'Name', { value: person?.name || '', required: true }),
      field('email', 'Email', { value: person?.email || '', required: !person, placeholder: 'name@3dots.travel' }),
      field('role', 'Team', { type: 'select', value: person?.role || 'operator', options: ['owner', 'admin', 'reservations', 'operations', 'accounts', 'operator', 'viewer'].map(r => ({ value: r, label: r })) }),
      person ? field('status', 'Status', { type: 'select', value: person.status, options: [{ value: 'active', label: 'active' }, { value: 'disabled', label: 'disabled' }] }) : field('password', 'Password', { type: 'password', placeholder: 'at least 8 characters' }),
    ],
    onSubmit: values => (person ? api.put(`/staff/${person.id}`, values) : api.post('/staff', values)),
  });
}

/* AUDIT ------------------------------------------------------------------- */
PANELS.audit = async params => {
  const data = await api.get(`/audit?limit=200${params.search ? `&search=${encodeURIComponent(params.search)}` : ''}`);
  const wrap = h('div');

  wrap.appendChild(h('div', { class: 'dk-bar' }, [
    h('input', {
      class: 'dk-in', value: params.search || '', placeholder: 'search the trail…', style: 'min-width:220px',
      onkeydown: e => { if (e.key === 'Enter') openDesk('audit', { search: e.target.value }); },
    }),
    h('span', { class: 'sp' }),
    h('span', { class: 'dk-dim', text: `${data.total} entries` }),
  ]));

  wrap.appendChild(table([
    { label: 'Created', cell: a => when(a.createdAt) },
    { label: 'Action', cell: a => h('span', { class: 'dk-mono dk-strong', text: a.action }) },
    { label: 'Target', cell: a => h('span', { class: 'dk-dim', text: a.targetType || '—' }) },
    { label: 'Detail', cell: a => h('span', { class: 'dk-dim', text: briefMeta(a.metadata) }) },
    { label: 'Result', cell: a => h('span', { class: `chip ${a.result === 'success' ? 'done' : 'blocked'}`, text: a.result }) },
  ], data.entries, { empty: 'Nothing in the trail yet.' }));

  return wrap;
};

PANELS.design = PANELS.leads;

/* QUOTATION ENGINE (Module 1, Slide 6) ----------------------------------- */
PANELS.quotes = async params => {
  const [data, suppliersData, leadsData] = await Promise.all([
    api.get(`/quotes${params.leadId ? `?leadId=${encodeURIComponent(params.leadId)}` : ''}`),
    api.get('/suppliers'),
    api.get('/leads?limit=60'),
  ]);
  const wrap = h('div');

  wrap.appendChild(h('div', { class: 'dk-bar' }, [
    h('button', {
      class: 'dk-btn', text: '+ CAPTURE SUPPLIER QUOTE',
      onclick: () => quoteForm(params.leadId, suppliersData.suppliers, leadsData.leads),
    }),
    params.leadId ? h('button', {
      class: 'dk-btn ghost', text: '◂ BACK TO TRIP DESIGN',
      onclick: () => openDesk('design', { id: params.leadId }),
    }) : null,
    h('span', { class: 'sp' }),
    h('span', { class: 'dk-dim', text: `${data.quotes.length} quote(s) captured · Lowest: ${data.comparison.lowestQuoteAmount ? '₹' + Number(data.comparison.lowestQuoteAmount).toLocaleString('en-IN') : 'None'}` }),
  ]));

  if (data.comparison.lowestQuoteAmount > 0) {
    wrap.appendChild(h('div', { class: 'dk-row', style: 'margin-bottom:12px' }, [
      h('div', { class: 'dk-card', style: 'flex:1;padding:10px 14px' }, [
        h('div', { class: 'dk-dim', style: 'font-size:11px', text: 'LOWEST SUPPLIER QUOTE' }),
        h('div', { class: 'dk-strong', style: 'font-size:16px;color:#1B6C5F', text: `₹${Number(data.comparison.lowestQuoteAmount).toLocaleString('en-IN')}` }),
        h('div', { class: 'dk-dim', text: `Provided by ${data.comparison.lowestSupplierName || 'Supplier'}` }),
      ]),
      h('div', { class: 'dk-card', style: 'flex:1;padding:10px 14px' }, [
        h('div', { class: 'dk-dim', style: 'font-size:11px', text: 'PRICE CALCULATION' }),
        h('div', { class: 'dk-strong', style: 'font-size:14px', text: 'Net Quote + Staff Margin % = Selling Price' }),
        h('div', { class: 'dk-dim', text: 'Staff can adjust margins per supplier quote' }),
      ]),
    ]));
  }

  wrap.appendChild(table([
    { label: 'Date', cell: q => when(q.createdAt) },
    { label: 'Trip / Lead', cell: q => h('div', {}, [
      h('div', { class: 'dk-strong', text: q.leadTitle || 'Trip' }),
      h('div', { class: 'dk-dim', text: q.leadDestination || '—' }),
    ]) },
    { label: 'Supplier', cell: q => h('div', {}, [
      h('div', { class: 'dk-strong', text: q.supplierName || '—' }),
      h('div', { class: 'dk-dim', text: `${q.source || 'email'} quote` }),
    ]) },
    { label: 'Net Quote', cell: q => h('span', { class: 'dk-mono dk-strong', text: `${q.currency || 'INR'} ${Number(q.quoteAmount).toLocaleString('en-IN')}` }) },
    { label: 'Margin', cell: q => h('span', { class: 'chip hot', text: `+${q.staffMarginPercent || 10}%` }) },
    { label: 'Selling Price', cell: q => h('span', { class: 'dk-mono dk-strong', style: 'color:#047857', text: `${q.currency || 'INR'} ${Number(q.finalSellingPrice || q.quoteAmount).toLocaleString('en-IN')}` }) },
    { label: 'Status', cell: q => h('span', { class: `chip ${q.status === 'accepted' ? 'done' : 'active'}`, text: q.status }) },
    { label: '', cell: q => h('div', { class: 'dk-row' }, [
      q.status !== 'accepted' ? h('button', {
        class: 'dk-btn sm', text: 'SELECT WINNER',
        onclick: e => run(e.target, () => api.post(`/quotes/${q.id}/select`, {}), { done: 'Quote selected & pricing applied' }),
      }) : h('span', { class: 'chip done', text: 'SELECTED' }),
      h('button', {
        class: 'dk-btn sm ghost', text: 'DESIGN',
        onclick: () => openDesk('design', { id: q.leadId }),
      }),
    ]) },
  ], data.quotes, { empty: 'No supplier quotes captured yet. Click + CAPTURE SUPPLIER QUOTE to add one.' }));

  return wrap;
};

function quoteForm(defaultLeadId, suppliers, leads) {
  openForm({
    title: 'CAPTURE SUPPLIER QUOTE',
    submitLabel: 'SAVE QUOTE & PRICE',
    hint: 'Supplier quotes are recorded here. Staff sets the margin percentage to calculate the final customer price.',
    fields: [
      field('leadId', 'Trip / Lead', {
        type: 'select', value: defaultLeadId || (leads[0]?.id || ''),
        options: leads.map(l => ({ value: l.id, label: `${l.title} (${l.destination || 'trip'})` })),
        required: true,
      }),
      field('supplierId', 'Supplier Partner', {
        type: 'select', value: suppliers[0]?.id || '',
        options: suppliers.map(s => ({ value: s.id, label: `${s.name} (${s.category || 'Hotel/DMC'})` })),
        required: true,
      }),
      field('quoteAmount', 'Net Supplier Quote Amount (₹)', { type: 'number', placeholder: 'e.g. 74500', required: true, min: 1 }),
      field('staffMarginPercent', 'Staff Margin Markup (%)', { type: 'number', value: '10', placeholder: '10', required: true, step: '0.5' }),
      field('currency', 'Currency', { value: 'INR', required: true }),
      field('source', 'Quote Received Via', { type: 'select', value: 'email', options: [{ value: 'email', label: 'Email' }, { value: 'whatsapp', label: 'WhatsApp' }, { value: 'pdf', label: 'PDF Rate Card' }, { value: 'portal', label: 'Partner Portal' }] }),
      field('notes', 'Inclusions & Scope Notes', { type: 'textarea', placeholder: 'Accommodation, breakfast, transfers, tax inclusions...' }),
    ],
    onSubmit: values => api.post('/quotes', values),
  });
}

/* FOLLOW-UP AUTOMATION (Module 5, Slide 9) -------------------------------- */
PANELS.followups = async params => {
  const data = await api.get('/followups');
  const wrap = h('div');

  wrap.appendChild(h('div', { class: 'dk-bar' }, [
    h('button', {
      class: 'dk-btn', text: '⚡ RUN DUE FOLLOW-UPS NOW',
      onclick: e => run(e.target, () => api.post('/followups/process', {}), { done: 'Processed due automations' }),
    }),
    h('span', { class: 'sp' }),
    h('span', { class: 'dk-dim', text: `${data.followups.length} scheduled event(s) · ${data.pendingCount} pending in queue` }),
  ]));

  wrap.appendChild(h('div', { class: 'dk-row', style: 'margin-bottom:12px;gap:8px' }, [
    h('div', { class: 'dk-card', style: 'flex:1;padding:8px 12px' }, [
      h('div', { class: 'dk-dim', style: 'font-size:10.5px', text: 'DAY 0' }),
      h('div', { class: 'dk-strong', text: 'Quotation Dispatch' }),
      h('div', { class: 'dk-dim', text: 'WhatsApp + Email sent together' }),
    ]),
    h('div', { class: 'dk-card', style: 'flex:1;padding:8px 12px' }, [
      h('div', { class: 'dk-dim', style: 'font-size:10.5px', text: 'DAY 2' }),
      h('div', { class: 'dk-strong', text: 'WhatsApp Friendly Nudge' }),
      h('div', { class: 'dk-dim', text: 'Automated review check' }),
    ]),
    h('div', { class: 'dk-card', style: 'flex:1;padding:8px 12px' }, [
      h('div', { class: 'dk-dim', style: 'font-size:10.5px', text: 'DAY 5' }),
      h('div', { class: 'dk-strong', text: 'Email Itinerary Check-in' }),
      h('div', { class: 'dk-dim', text: 'Inquire on adjustments' }),
    ]),
    h('div', { class: 'dk-card', style: 'flex:1;padding:8px 12px' }, [
      h('div', { class: 'dk-dim', style: 'font-size:10.5px', text: 'DAY 10' }),
      h('div', { class: 'dk-strong', text: 'Consultant Phone Task' }),
      h('div', { class: 'dk-dim', text: 'Final booking decision' }),
    ]),
  ]));

  wrap.appendChild(table([
    { label: 'Scheduled For', cell: f => when(f.scheduledFor) },
    { label: 'Trip / Lead', cell: f => h('div', {}, [
      h('div', { class: 'dk-strong', text: f.leadTitle }),
      h('div', { class: 'dk-dim', text: f.leadDestination || '—' }),
    ]) },
    { label: 'Target', cell: f => h('div', {}, [
      h('div', { class: 'dk-strong', text: f.contactName || f.targetId || 'Guest' }),
      h('div', { class: 'dk-dim', text: f.targetType }),
    ]) },
    { label: 'Channel', cell: f => h('span', { class: `chip ${f.channel === 'whatsapp' ? 'done' : 'active'}`, text: f.channel.toUpperCase() }) },
    { label: 'Cadence Step', cell: f => h('span', { class: 'chip', text: `Day ${f.stepDay}` }) },
    { label: 'Status', cell: f => h('span', { class: `chip ${f.status === 'sent' ? 'done' : f.status === 'pending' ? 'active' : 'blocked'}`, text: f.status }) },
    { label: '', cell: f => h('div', { class: 'dk-row' }, [
      f.status === 'pending' ? h('button', {
        class: 'dk-btn sm', text: 'SEND NOW',
        onclick: e => run(e.target, () => api.post(`/followups/${f.id}/send-now`, {}), { done: 'Dispatched follow-up' }),
      }) : null,
      f.status === 'pending' ? h('button', {
        class: 'dk-btn sm ghost', text: 'CANCEL',
        onclick: e => run(e.target, () => api.post(`/followups/lead/${f.leadId}/cancel`, {}), { done: 'Cancelled cadence' }),
      }) : null,
      h('button', { class: 'dk-btn sm ghost', text: 'OPEN TRIP', onclick: () => openDesk('design', { id: f.leadId }) }),
    ]) },
  ], data.followups, { empty: 'No follow-up events in queue. Sending quotations automatically schedules follow-ups.' }));

  return wrap;
};

/* BOOKINGS & PAYMENTS (Module 7, Slide 11) -------------------------------- */
PANELS.bookings = async params => {
  const [data, leadsData] = await Promise.all([
    api.get('/bookings'),
    api.get('/leads?status=approved,quote_sent'),
  ]);
  const wrap = h('div');

  wrap.appendChild(h('div', { class: 'dk-bar' }, [
    h('button', {
      class: 'dk-btn', text: '+ CREATE BOOKING HANDOVER',
      onclick: () => bookingForm(leadsData.leads),
    }),
    h('span', { class: 'sp' }),
    h('span', { class: 'dk-dim', text: `${data.bookings.length} confirmed booking(s)` }),
  ]));

  wrap.appendChild(table([
    { label: 'Reference', cell: b => h('span', { class: 'dk-mono dk-strong', text: b.bookingReference }) },
    { label: 'Trip', cell: b => h('div', {}, [
      h('div', { class: 'dk-strong', text: b.leadTitle }),
      h('div', { class: 'dk-dim', text: b.leadDestination }),
    ]) },
    { label: 'Guest', cell: b => h('div', {}, [
      h('div', { class: 'dk-strong', text: b.contactName || 'Guest' }),
      h('div', { class: 'dk-dim', text: b.contactPhone || b.contactEmail || '—' }),
    ]) },
    { label: 'Total Investment', cell: b => h('span', { class: 'dk-mono dk-strong', text: `₹${Number(b.totalAmount).toLocaleString('en-IN')}` }) },
    { label: 'Paid', cell: b => h('span', { class: 'dk-mono', style: 'color:#047857;font-weight:700', text: `₹${Number(b.paidAmount).toLocaleString('en-IN')}` }) },
    { label: 'Balance', cell: b => {
      const bal = Number(b.totalAmount) - Number(b.paidAmount);
      return h('span', { class: 'dk-mono', style: bal > 0 ? 'color:#b45309;font-weight:700' : 'color:#64748b', text: `₹${bal.toLocaleString('en-IN')}` });
    } },
    { label: 'Status', cell: b => h('span', { class: `chip ${b.status === 'confirmed' ? 'done' : 'active'}`, text: b.status }) },
    { label: '', cell: b => h('div', { class: 'dk-row' }, [
      h('button', {
        class: 'dk-btn sm', text: 'MILESTONES & PAY',
        onclick: () => bookingDetailModal(b.id),
      }),
      h('button', {
        class: 'dk-btn sm ghost', text: 'TRIP',
        onclick: () => openDesk('design', { id: b.leadId }),
      }),
    ]) },
  ], data.bookings, { empty: 'No confirmed bookings yet. Convert an approved quotation into a booking handover.' }));

  return wrap;
};

function bookingForm(leads) {
  openForm({
    title: 'BOOKING HANDOVER TO OPERATIONS',
    submitLabel: 'CONFIRM BOOKING',
    hint: 'Handing over a confirmed trip automatically sets up the 30%/50%/20% payment schedule, visa checklists, and pre-departure alerts.',
    fields: [
      field('leadId', 'Confirmed Lead', {
        type: 'select', value: leads[0]?.id || '',
        options: leads.map(l => ({ value: l.id, label: `${l.title} (${l.destination || 'trip'}) - ${l.status}` })),
        required: true,
      }),
      field('totalAmount', 'Total Package Selling Price (₹)', { type: 'number', placeholder: '85000', required: true }),
      field('startDate', 'Departure / Start Date', { type: 'date', required: true }),
      field('endDate', 'Return / End Date', { type: 'date', required: true }),
      field('notes', 'Operations & Handover Notes', { type: 'textarea', placeholder: 'Special meal requests, flight seat preferences, anniversary notes...' }),
    ],
    onSubmit: values => api.post('/bookings', values),
  });
}

async function bookingDetailModal(bookingId) {
  const data = await api.get(`/bookings/${bookingId}`);
  const b = data.booking;
  const modal = h('div', { class: 'dk-modal' });

  const paymentsList = h('div', { style: 'margin-top:12px' }, data.payments.map(p =>
    h('div', { class: 'dk-card', style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px;padding:10px 14px' }, [
      h('div', {}, [
        h('div', { class: 'dk-strong', text: p.title }),
        h('div', { class: 'dk-dim', text: `Due: ${new Date(p.dueDate).toLocaleDateString('en-IN')}` }),
      ]),
      h('span', { class: 'dk-mono dk-strong', style: 'font-size:14px', text: `₹${Number(p.amount).toLocaleString('en-IN')}` }),
      h('span', { class: `chip ${p.status === 'paid' ? 'done' : 'active'}`, text: p.status }),
      h('div', { class: 'dk-row' }, [
        p.status !== 'paid' ? h('button', {
          class: 'dk-btn sm', text: 'MARK PAID',
          onclick: async e => {
            await run(e.target, () => api.post(`/bookings/${b.id}/payments/${p.id}/pay`, { paymentMethod: 'Bank Transfer' }), { done: 'Payment recorded' });
            modal.remove();
            render('bookings');
          },
        }) : null,
        p.status !== 'paid' ? h('button', {
          class: 'dk-btn sm ghost', text: '💬 REMIND WHATSAPP',
          onclick: async e => {
            await run(e.target, () => api.post(`/bookings/${b.id}/payments/${p.id}/remind`, {}), { done: 'WhatsApp reminder sent' });
          },
        }) : null,
      ]),
    ])));

  const sheet = h('div', { class: 'dk-sheet', style: 'max-width:650px' }, [
    h('h3', { text: `BOOKING · ${b.bookingReference}` }),
    h('div', { class: 'dk-dim', text: `${b.leadTitle} • ${b.contactName || 'Guest'}` }),
    h('div', { class: 'dk-row', style: 'margin:14px 0 8px' }, [
      h('div', { class: 'dk-card', style: 'flex:1;padding:8px 12px' }, [
        h('div', { class: 'dk-dim', style: 'font-size:10px', text: 'TOTAL' }),
        h('div', { class: 'dk-strong', text: `₹${Number(b.totalAmount).toLocaleString('en-IN')}` }),
      ]),
      h('div', { class: 'dk-card', style: 'flex:1;padding:8px 12px' }, [
        h('div', { class: 'dk-dim', style: 'font-size:10px', text: 'PAID' }),
        h('div', { class: 'dk-strong', style: 'color:#047857', text: `₹${Number(b.paidAmount).toLocaleString('en-IN')}` }),
      ]),
      h('div', { class: 'dk-card', style: 'flex:1;padding:8px 12px' }, [
        h('div', { class: 'dk-dim', style: 'font-size:10px', text: 'BALANCE' }),
        h('div', { class: 'dk-strong', style: 'color:#b45309', text: `₹${(Number(b.totalAmount) - Number(b.paidAmount)).toLocaleString('en-IN')}` }),
      ]),
    ]),
    h('h4', { style: 'margin:14px 0 6px', text: 'PAYMENT INSTALMENTS' }),
    paymentsList,
    h('div', { class: 'dk-foot', style: 'margin-top:20px' }, [
      h('button', { class: 'dk-btn', text: 'CLOSE', onclick: () => modal.remove() }),
    ]),
  ]);

  modal.appendChild(sheet);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  overlay.querySelector('.dk-panel').appendChild(modal);
}

/* TRAVELLER CARE & VISA (Module 8, Slide 11) ------------------------------ */
PANELS.care = async params => {
  const [visaData, careData] = await Promise.all([
    api.get('/care/visa'),
    api.get('/care/items'),
  ]);
  const wrap = h('div');

  wrap.appendChild(h('div', { class: 'dk-bar' }, [
    h('button', {
      class: 'dk-btn', text: '📢 SEND REPEAT MARKETING CAMPAIGN',
      onclick: () => repeatMarketingForm(),
    }),
    h('span', { class: 'sp' }),
    h('span', { class: 'dk-dim', text: `${visaData.docs.length} visa documents · ${careData.items.length} traveller care actions` }),
  ]));

  wrap.appendChild(h('h3', { style: 'margin:12px 0 8px;font-size:13px;letter-spacing:.08em', text: 'VISA DOCUMENT CHECKLISTS' }));
  wrap.appendChild(table([
    { label: 'Destination', cell: v => h('span', { class: 'chip', text: v.destination || 'International' }) },
    { label: 'Document Required', cell: v => h('span', { class: 'dk-strong', text: v.documentName }) },
    { label: 'Trip Title', cell: v => h('span', { class: 'dk-dim', text: v.leadTitle }) },
    { label: 'Status', cell: v => h('span', { class: `chip ${v.status === 'verified' ? 'done' : v.status === 'submitted' ? 'active' : 'blocked'}`, text: v.status }) },
    { label: '', cell: v => h('div', { class: 'dk-row' }, [
      v.status !== 'verified' ? h('button', {
        class: 'dk-btn sm', text: 'VERIFY DOC',
        onclick: e => run(e.target, () => api.post(`/care/visa/${v.id}/verify`, { status: 'verified' }), { done: 'Document verified' }),
      }) : h('span', { class: 'chip done', text: 'VERIFIED' }),
      h('button', { class: 'dk-btn sm ghost', text: 'REJECT', onclick: e => run(e.target, () => api.post(`/care/visa/${v.id}/verify`, { status: 'rejected' }), { done: 'Document rejected' }) }),
    ]) },
  ], visaData.docs, { empty: 'No active visa checklist items on file.' }));

  wrap.appendChild(h('h3', { style: 'margin:24px 0 8px;font-size:13px;letter-spacing:.08em', text: 'PRE-DEPARTURE PACKS & POST-TRIP REVIEWS' }));
  wrap.appendChild(table([
    { label: 'Due Date', cell: c => when(c.scheduledFor) },
    { label: 'Type', cell: c => h('span', { class: `chip ${c.type === 'feedback' ? 'hot' : 'done'}`, text: c.type.replace('_', ' ').toUpperCase() }) },
    { label: 'Guest', cell: c => h('div', {}, [
      h('div', { class: 'dk-strong', text: c.contactName || 'Guest' }),
      h('div', { class: 'dk-dim', text: c.phone || '—' }),
    ]) },
    { label: 'Trip', cell: c => h('span', { class: 'dk-dim', text: c.leadTitle }) },
    { label: 'Rating / Review', cell: c => c.rating ? h('span', { class: 'dk-strong', style: 'color:#b45309', text: `${'★'.repeat(c.rating)}${'☆'.repeat(5 - c.rating)} (${c.rating}/5)` }) : h('span', { class: 'dk-dim', text: 'Pending response' }) },
    { label: 'Status', cell: c => h('span', { class: `chip ${c.status === 'received' ? 'done' : 'active'}`, text: c.status }) },
    { label: '', cell: c => h('div', { class: 'dk-row' }, [
      c.type === 'feedback' && c.status !== 'received' ? h('button', {
        class: 'dk-btn sm', text: 'RECORD REVIEW',
        onclick: () => feedbackForm(c.id),
      }) : null,
    ]) },
  ], careData.items, { empty: 'No traveller care records yet.' }));

  return wrap;
};

function repeatMarketingForm() {
  openForm({
    title: 'SEND REPEAT MARKETING CAMPAIGN',
    submitLabel: 'SEND VIA WHATSAPP',
    hint: 'Dispatches targeted early-bird travel promotions to past customers who booked trips with 3dots.',
    fields: [
      field('title', 'Campaign Offer Title', { value: 'Exclusive Early Bird: Bali & Maldives Private Villas', required: true }),
      field('message', 'Campaign Message', { type: 'textarea', value: 'Special loyalty rates for your next vacation. Includes complimentary airport transfers and private dinner upgrade.', required: true }),
    ],
    onSubmit: values => api.post('/care/repeat-marketing', values),
  });
}

function feedbackForm(careId) {
  openForm({
    title: 'RECORD POST-TRIP GUEST FEEDBACK',
    submitLabel: 'SUBMIT REVIEW',
    hint: 'Collect customer satisfaction rating and review comments after trip completion.',
    fields: [
      field('rating', 'Star Rating (1 to 5 Stars)', { type: 'select', value: '5', options: [{ value: '5', label: '★★★★★ 5 - Exceptional' }, { value: '4', label: '★★★★☆ 4 - Great' }, { value: '3', label: '★★★☆☆ 3 - Good' }, { value: '2', label: '★★☆☆☆ 2 - Fair' }, { value: '1', label: '★☆☆☆☆ 1 - Poor' }] }),
      field('feedbackText', 'Client Feedback & Testimonial', { type: 'textarea', placeholder: 'The itinerary was perfectly coordinated. The private transfers and resort recommendations were excellent...', required: true }),
    ],
    onSubmit: values => api.post(`/care/feedback/${careId}/submit`, values),
  });
}

/* MODULE MANAGER & ZOWIZ (Slides 12, 13, 14, 20) ------------------------- */
PANELS.modules = async params => {
  const [data, zowizData] = await Promise.all([
    api.get('/modules'),
    api.get('/zowiz/status'),
  ]);
  const wrap = h('div');

  wrap.appendChild(h('div', { class: 'dk-bar' }, [
    h('span', { class: 'dk-dim', text: `PLUG-AND-PLAY ARCHITECTURE · ${data.summary.installed} of ${data.summary.total} modules installed` }),
    h('span', { class: 'sp' }),
    h('span', { class: 'chip done', text: 'EVENT BUS ACTIVE' }),
  ]));

  wrap.appendChild(h('div', { class: 'dk-card', style: 'padding:14px 18px;margin-bottom:18px;background:linear-gradient(180deg,#F8FAFC,#FFFFFF)' }, [
    h('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:12px' }, [
      h('div', {}, [
        h('div', { class: 'dk-strong', style: 'font-size:14px;color:#0F172A', text: 'ZOWIZ MARKETING CRM INTEGRATION' }),
        h('div', { class: 'dk-dim', style: 'margin-top:2px', text: 'Bi-directional sync: pulls inbound marketing leads and pushes back enquiry/booking status.' }),
      ]),
      h('span', { class: `chip ${zowizData.connected ? 'done' : 'blocked'}`, text: zowizData.connected ? 'SYNC CONNECTED' : 'OFFLINE' }),
    ]),
    h('div', { class: 'dk-row', style: 'margin-top:12px' }, [
      h('button', {
        class: 'dk-btn sm', text: '📥 TEST INBOUND LEAD PULL',
        onclick: e => run(e.target, () => api.post('/zowiz/webhook/inbound-lead', {
          customerName: 'Aarav Patel',
          phone: '+919876543210',
          email: 'aarav.patel@example.com',
          destination: 'Switzerland & Paris',
          campaign: 'Autumn Premium Luxury 2026',
        }), { done: 'Imported Zowiz lead' }),
      }),
      h('span', { class: 'dk-dim', text: `${zowizData.recentSyncCount} recent sync events recorded in ledger` }),
    ]),
  ]));

  wrap.appendChild(h('h3', { style: 'margin:14px 0 8px;font-size:13px;letter-spacing:.08em', text: 'MODULE REGISTRY (PLUG-AND-PLAY TILES)' }));

  const grid = h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill, minmax(280px, 1fr));gap:12px' });
  for (const mod of data.all) {
    const isCore = mod.category === 'core';
    const card = h('div', { class: 'dk-card', style: 'display:flex;flex-direction:column;padding:14px' }, [
      h('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px' }, [
        h('span', { class: 'dk-strong', text: mod.name }),
        h('span', { class: `chip ${mod.category === 'core' ? 'done' : mod.category === 'travel' ? 'hot' : 'active'}`, text: mod.category.toUpperCase() }),
      ]),
      h('div', { class: 'dk-dim', style: 'font-size:12px;flex:1', text: mod.description || 'Module package' }),
      h('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-top:12px;padding-top:8px;border-top:1px solid #F1F5F9' }, [
        h('span', { class: 'dk-mono dk-dim', style: 'font-size:11px', text: `v${mod.version}` }),
        !isCore ? h('button', {
          class: `dk-btn sm ${mod.installed ? 'ghost' : ''}`, text: mod.installed ? 'INSTALLED ✓' : 'INSTALL',
          onclick: e => run(e.target, () => api.post(`/modules/${mod.moduleId}/toggle`, {}), { done: 'Toggled module' }),
        }) : h('span', { class: 'chip done', text: 'CORE PLATFORM' }),
      ]),
    ]);
    grid.appendChild(card);
  }
  wrap.appendChild(grid);

  return wrap;
};

function briefMeta(metadata) {
  if (!metadata) return '—';
  const bits = [];
  for (const [k, v] of Object.entries(metadata)) {
    if (v === null || v === undefined || v === '' || v === false) continue;
    bits.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v).slice(0, 40) : String(v).slice(0, 48)}`);
  }
  return bits.slice(0, 3).join(' · ') || '—';
}

export { toast };
