// Messaging Hub — WhatsApp Business messaging adapter (Module 4)
import { env, db, newId } from '../db/index.mjs';
import { logAudit } from './audit.mjs';
import * as plivo from './plivo.mjs';

export const whatsappConfigured = () => !!(env.WHATSAPP_API_TOKEN || (plivo.configured() && env.WHATSAPP_SOURCE_NUMBER));

/**
 * Send a WhatsApp message to a customer or supplier.
 * Supports Plivo WhatsApp API, direct WhatsApp Cloud API, or graceful simulated outbox.
 */
export async function sendWhatsAppMessage({ organizationId, to, text, mediaUrl = null, templateKey = null }) {
  if (!to) throw new Error('WhatsApp destination number required');
  const cleanTo = String(to).replace(/[^\d+]/g, '');

  console.log(`[whatsapp] dispatching to ${cleanTo} (${templateKey || 'direct text'})`);

  let result = { success: true, messageId: `wa_${newId()}`, provider: 'simulated' };

  if (env.WHATSAPP_API_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID) {
    // Direct Meta WhatsApp Cloud API
    try {
      const res = await fetch(`https://graph.facebook.com/v19.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.WHATSAPP_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: cleanTo.replace(/^\+/, ''),
          type: 'text',
          text: { body: text },
        }),
      });
      const data = await res.json();
      if (res.ok) {
        result = { success: true, messageId: data.messages?.[0]?.id || `wa_${newId()}`, provider: 'meta' };
      } else {
        console.warn('[whatsapp] Meta API returned error:', data.error?.message);
        result = { success: false, error: data.error?.message, provider: 'meta' };
      }
    } catch (e) {
      console.warn('[whatsapp] Meta API call failed:', e.message);
      result = { success: false, error: e.message, provider: 'meta' };
    }
  } else if (plivo.configured() && env.WHATSAPP_SOURCE_NUMBER) {
    // Plivo WhatsApp Channel
    try {
      const auth = Buffer.from(`${env.PLIVO_AUTH_ID}:${env.PLIVO_AUTH_TOKEN}`).toString('base64');
      const res = await fetch(`https://api.plivo.com/v1/Account/${env.PLIVO_AUTH_ID}/Message/`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          src: env.WHATSAPP_SOURCE_NUMBER,
          dst: cleanTo,
          text,
          type: 'whatsapp',
          ...(mediaUrl ? { media_urls: [mediaUrl] } : {}),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        result = { success: true, messageId: data.message_uuid?.[0] || `wa_${newId()}`, provider: 'plivo' };
      } else {
        result = { success: false, error: data.message || 'Plivo error', provider: 'plivo' };
      }
    } catch (e) {
      result = { success: false, error: e.message, provider: 'plivo' };
    }
  } else {
    // Simulated outbox for development/test
    console.log(`[whatsapp:simulated] To: ${cleanTo}\nMessage: ${text.slice(0, 100)}...`);
  }

  // Record in messages table if organizationId is available
  if (organizationId) {
    try {
      await db.query(`
        INSERT INTO messages ("id", "organizationId", "direction", "type", "from", "to", "body", "status", "sentAt")
        VALUES ($1, $2, 'outbound', 'whatsapp', $3, $4, $5, $6, now())
      `, [result.messageId, organizationId, env.WHATSAPP_SOURCE_NUMBER || '+18003DOTS', cleanTo, text, result.success ? 'delivered' : 'failed']);

      await logAudit({
        action: 'whatsapp.send',
        targetType: 'Message',
        targetId: result.messageId,
        metadata: { to: cleanTo, templateKey, provider: result.provider, success: result.success },
      });
    } catch (err) {
      console.warn('[whatsapp] logging to messages table failed:', err.message);
    }
  }

  return result;
}

/**
 * Format quotation dispatch text for WhatsApp.
 */
export function formatQuotationWhatsApp({ customerName, title, destination, finalPrice, currency = 'INR', pdfLink = '' }) {
  const priceDisplay = finalPrice ? `\n*Total Package Price:* ${currency} ${Number(finalPrice).toLocaleString('en-IN')}` : '';
  return `*Hello ${customerName}!*\n\nWe have prepared your bespoke travel proposal for *${title}* (*${destination}*).${priceDisplay}\n\n${pdfLink ? `You can view your detailed itinerary and flight details here:\n${pdfLink}\n\n` : ''}Reply to this chat with any questions or revisions and our holiday desk will be happy to assist!`;
}

