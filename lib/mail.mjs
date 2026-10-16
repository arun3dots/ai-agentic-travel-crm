// The despatch desk — the two mails that leave the office.
//
// Sent through Resend's REST API with fetch (the SDK only wraps this), so the app carries no extra
// dependency. When no key is configured, or the address is a test fixture, the mail is composed in
// full and reported as simulated rather than silently dropped — the outbox always tells the truth
// about what left the building.
import { env } from '../db/index.mjs';

const FROM = () => env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
const fromHeader = name => (FROM().includes('<') ? FROM() : `${name} <${FROM()}>`);
const clean = s => String(s ?? '').replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_');

export const mailConfigured = () => !!env.RESEND_API_KEY;

async function send({ to, subject, html, filename, attachment }) {
  const simulated = !mailConfigured() || String(to).endsWith('.test') || env.NODE_ENV === 'test';
  if (simulated) {
    console.log(`[despatch:simulated] "${subject}" -> ${to} (${attachment ? attachment.length : 0} bytes attached)`);
    return { success: true, id: `sim_${Date.now()}`, simulated: true };
  }
  try {
    const body = {
      from: fromHeader('3dots Travel'),
      to: [to],
      subject,
      html,
      ...(attachment ? { attachments: [{ filename, content: Buffer.from(attachment).toString('base64') }] } : {}),
    };
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const message = json?.message || json?.error?.message || `HTTP ${res.status}`;
      console.error('[despatch] Resend refused the mail:', message);
      return { success: false, error: message };
    }
    return { success: true, id: json?.id, simulated: false };
  } catch (e) {
    console.error('[despatch] Resend exception:', e.message);
    return { success: false, error: e.message };
  }
}

const shell = (eyebrow, sub, gradient, inner) => `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#fafafa;border-radius:12px;color:#18181b">
    <div style="background:${gradient};padding:32px 24px;border-radius:8px 8px 0 0;text-align:center;color:#fff">
      <h1 style="margin:0;font-size:23px;font-weight:700;letter-spacing:-.5px">${eyebrow}</h1>
      <p style="margin:6px 0 0;font-size:13px;opacity:.9">${sub}</p>
    </div>
    <div style="background:#fff;padding:32px 24px;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px">${inner}
      <div style="margin-top:32px;padding-top:20px;border-top:1px solid #e4e4e7;font-size:12px;color:#a1a1aa;text-align:center">
        3dots Travel — Holiday Desk
      </div>
    </div>
  </div>`;

/** The guest's itinerary, with the PDF attached. */
export async function sendCustomerItinerary({ to, customerName, title, destination, pdfBuffer }) {
  const filename = `${clean(destination)}_Itinerary.pdf`;
  const html = shell('3dots Travel', 'Curated private itinerary', 'linear-gradient(135deg,#258C7B 0%,#1B6C5F 100%)', `
    <p style="font-size:16px;line-height:24px;margin-top:0">Dear <strong>${customerName}</strong>,</p>
    <p style="font-size:15px;line-height:24px;color:#3f3f46">
      We are delighted to present your customised travel itinerary for <strong>${destination}</strong>.
      Following your consultation, our travel desk has put together the plan below.
    </p>
    <div style="background:#EBF7F5;border-left:4px solid #258C7B;padding:16px;margin:24px 0;border-radius:4px">
      <h3 style="margin:0 0 4px;font-size:15px;color:#18181b">${title}</h3>
      <p style="margin:0;font-size:13px;color:#64748B">Destination: ${destination} • Full PDF attached</p>
    </div>
    <p style="font-size:14px;line-height:22px;color:#3f3f46">
      Attached: <strong>${filename}</strong> — the day-by-day plan, accommodation and what is included.
    </p>
    <p style="font-size:14px;line-height:22px;color:#3f3f46;margin-bottom:0">
      Reply to this email with any changes and we will rework it.
    </p>`);
  return send({ to, subject: `Your Bespoke Travel Itinerary: ${title}`, html, filename, attachment: pdfBuffer });
}

/** The supplier's quotation request (RFQ), with the same document attached. */
export async function sendSupplierRfq({ to, supplierName, contactPerson, customerName, title, destination, pdfBuffer }) {
  const filename = `RFQ_${clean(destination)}_Quotation.pdf`;
  const greeting = contactPerson ? `Dear ${contactPerson}` : `Dear Team at ${supplierName}`;
  const html = shell('B2B Request for Quotation', 'Partner supplier quotation request', 'linear-gradient(135deg,#0f172a 0%,#1e293b 100%)', `
    <p style="font-size:15px;line-height:24px;margin-top:0">${greeting},</p>
    <p style="font-size:14px;line-height:22px;color:#3f3f46">
      Please review the following request for quotation for our client <strong>${customerName}</strong> travelling to <strong>${destination}</strong>.
    </p>
    <div style="background:#f8fafc;border:1px solid #cbd5e1;padding:16px;margin:20px 0;border-radius:6px">
      <table style="width:100%;font-size:13px;color:#334155;line-height:20px">
        <tr><td style="font-weight:600;width:35%">Trip:</td><td>${title}</td></tr>
        <tr><td style="font-weight:600">Destination:</td><td>${destination}</td></tr>
        <tr><td style="font-weight:600">Supplier:</td><td>${supplierName}</td></tr>
      </table>
    </div>
    <p style="font-size:14px;line-height:22px;color:#3f3f46">
      Attached: <strong>${filename}</strong> — the scope and the requested service dates.
    </p>
    <p style="font-size:14px;line-height:22px;color:#3f3f46;margin-bottom:0">
      Kindly reply with your net rate, availability and booking terms.
    </p>`);
  return send({ to, subject: `[RFQ] Quotation Request: ${destination} (${supplierName}) - ${title}`, html, filename, attachment: pdfBuffer });
}

/** A plain note (no attachment) — used for internal notes and follow-ups. */
export async function sendNote({ to, subject, body }) {
  const html = shell('3dots Travel', 'Holiday desk note', 'linear-gradient(135deg,#258C7B 0%,#1B6C5F 100%)', `
    <p style="font-size:14px;line-height:22px;color:#3f3f46;white-space:pre-wrap">${String(body || '').replace(/</g, '&lt;')}</p>`);
  return send({ to, subject, html });
}
