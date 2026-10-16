// Shared plumbing for the desk routes: one error shape, one place that turns a thrown message into
// a 400/404/500 the page can show, and the small coercions every form needs.
import { orgId } from '../db/index.mjs';

/** Wrap an async handler so a rejected promise becomes a JSON error instead of a hung request. */
export const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(err => {
  const status = err.status || 500;
  if (status >= 500) console.error(`[api] ${req.method} ${req.originalUrl}:`, err.message);
  res.status(status).json({ error: err.message || 'the office hit an error' });
});

export function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** Trimmed, non-empty string or 404. */
export function requireId(value, what) {
  const v = String(value ?? '').trim();
  if (!v) throw fail(400, `missing ${what || 'id'}`);
  return v;
}

export const text = (v, { max = 4000, required = false, field = 'value' } = {}) => {
  const s = String(v ?? '').trim();
  if (required && !s) throw fail(400, `${field} is required`);
  return s.slice(0, max) || null;
};

/** E.164-ish: keep digits and a leading +. */
export function phoneNumber(v, { required = false, field = 'phone' } = {}) {
  const raw = String(v ?? '').trim();
  if (!raw) {
    if (required) throw fail(400, `${field} is required`);
    return null;
  }
  const plus = raw.startsWith('+');
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 6) throw fail(400, `${field} does not look like a phone number`);
  return (plus ? '+' : '') + digits;
}

export function emailAddress(v, { required = false, field = 'email' } = {}) {
  const s = String(v ?? '').trim();
  if (!s) {
    if (required) throw fail(400, `${field} is required`);
    return null;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw fail(400, `${field} is not a valid email address`);
  return s;
}

export const bool = v => v === true || v === 'true' || v === 'yes' || v === 'on' || v === 1 || v === '1';

export const int = (v, fallback = 0) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

/** The organization scope plus a tiny row-count helper the dashboard leans on. */
export async function scope() {
  return orgId();
}
