// The one place the page talks to the office API.
const BASE = '/api';

async function request(path, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const textBody = await res.text();
  let json = null;
  try { json = textBody ? JSON.parse(textBody) : null; } catch { /* not json */ }
  if (!res.ok) {
    const err = new Error(json?.error || `${method} ${path} → HTTP ${res.status}`);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

export const api = {
  get: path => request(path),
  post: (path, body) => request(path, { method: 'POST', body }),
  put: (path, body) => request(path, { method: 'PUT', body }),
  patch: (path, body) => request(path, { method: 'PATCH', body }),
  del: path => request(path, { method: 'DELETE' }),
};

export const fmt = {
  /** "2 Oct, 14:05" — short enough for a table row. */
  when(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  },
  /** "1 h 12 m" · "4 m 30 s" · "47 s" */
  span(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    if (!s) return '—';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    if (h) return `${h} h ${m} m`;
    if (m) return `${m} m ${r} s`;
    return `${r} s`;
  },
  money(value, currency = 'USD') {
    if (value === null || value === undefined || value === '') return '—';
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return `${currency === 'INR' ? '₹' : '$'}${n.toFixed(2)}`;
  },
  phone(value) {
    const s = String(value || '');
    if (!s.startsWith('+') || s.length < 8) return s || '—';
    return `${s.slice(0, 3)} ${s.slice(3, 8)} ${s.slice(8)}`;
  },
  status(value) {
    return String(value || '—').replace(/_/g, ' ');
  },
};

/** Escape everything that goes into innerHTML — the office shows text people typed. */
export const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** A tiny element builder: h('div', { class: 'x' }, [child, 'text']). */
export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style') el.setAttribute('style', v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}
