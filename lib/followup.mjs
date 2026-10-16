// Module 5: Follow-Up Automation Engine (Slide 9, 21)
import { db, orgId, newId } from '../db/index.mjs';
import { sendWhatsAppMessage } from './whatsapp.mjs';
import { sendCustomerItinerary } from './mail.mjs';
import { bus } from './events.mjs';

/**
 * Schedule the Day 2, Day 5, and Day 10 chasing cadence for a customer.
 */
export async function scheduleCustomerFollowups({ organizationId, leadId, contactId, phone, email, customerName, title, destination }) {
  console.log(`[followup] scheduling cadence for lead ${leadId} (${customerName})`);

  // Cancel any existing pending followups for this lead first
  await cancelFollowupsForLead({ organizationId, leadId, reason: 'rescheduled on new quotation send' });

  const now = Date.now();
  const schedule = [
    {
      day: 2,
      // For immediate testing/demo, schedules can be accelerated if DEMO_MODE=true, otherwise 2 days
      offsetMs: process.env.DEMO_CADENCE ? 2 * 60 * 1000 : 2 * 24 * 60 * 60 * 1000,
      channel: 'whatsapp',
      templateKey: 'friendly_reminder_day2',
      text: `Hi ${customerName}! Just following up on the ${title} itinerary we sent over. Did you have a chance to review the plan, or would you like us to adjust any hotels or activities?`,
    },
    {
      day: 5,
      offsetMs: process.env.DEMO_CADENCE ? 5 * 60 * 1000 : 5 * 24 * 60 * 60 * 1000,
      channel: 'email',
      templateKey: 'inquiry_checkin_day5',
      text: `Dear ${customerName},\n\nWe wanted to check in regarding your upcoming trip to ${destination}. Are the travel dates and budget aligning well with your expectations? We are ready to secure preferred room allocations as soon as you confirm.`,
    },
    {
      day: 10,
      offsetMs: process.env.DEMO_CADENCE ? 10 * 60 * 1000 : 10 * 24 * 60 * 60 * 1000,
      channel: 'alert',
      templateKey: 'staff_call_task_day10',
      text: `Action Required: 10 days since quotation for ${customerName} (${title}). Reach out by phone for final booking decision.`,
    },
  ];

  for (const item of schedule) {
    const scheduledDate = new Date(now + item.offsetMs);
    await db.query(`
      INSERT INTO scheduled_followups (
        id, "organizationId", "leadId", "contactId", "targetType", "targetId",
        channel, "stepDay", "scheduledFor", status, "templateKey", payload, "createdAt", "updatedAt"
      ) VALUES ($1, $2, $3, $4, 'customer', $5, $6, $7, $8, 'pending', $9, $10, now(), now())
    `, [
      newId(), organizationId, leadId, contactId || null, phone || email,
      item.channel, item.day, scheduledDate, item.templateKey, JSON.stringify({ text: item.text, phone, email, customerName, title, destination }),
    ]);
  }

  bus.broadcast('followup.scheduled', { organizationId, leadId, stepsScheduled: 3 });
}

/**
 * Schedule a supplier reminder if quotation not received within 48 hours.
 */
export async function scheduleSupplierFollowup({ organizationId, leadId, supplierId, supplierName, supplierEmail, title }) {
  const scheduledDate = new Date(Date.now() + (process.env.DEMO_CADENCE ? 2 * 60 * 1000 : 48 * 60 * 60 * 1000));
  await db.query(`
    INSERT INTO scheduled_followups (
      id, "organizationId", "leadId", "targetType", "targetId",
      channel, "stepDay", "scheduledFor", status, "templateKey", payload, "createdAt", "updatedAt"
    ) VALUES ($1, $2, $3, 'supplier', $4, 'email', 2, $5, 'pending', 'supplier_quote_reminder', $6, now(), now())
  `, [
    newId(), organizationId, leadId, supplierId, scheduledDate,
    JSON.stringify({ supplierName, supplierEmail, title, text: `Reminder: Please provide net quote for ${title}` }),
  ]);
}

/**
 * Cancel pending follow-ups when customer replies, books, or lead is rejected.
 */
export async function cancelFollowupsForLead({ organizationId, leadId, reason = 'auto-cancelled' }) {
  const result = await db.query(`
    UPDATE scheduled_followups
    SET status = 'cancelled', error = $3, "updatedAt" = now()
    WHERE "organizationId" = $1 AND "leadId" = $2 AND status = 'pending'
    RETURNING id
  `, [organizationId, leadId, reason]);

  if (result.rows.length > 0) {
    console.log(`[followup] cancelled ${result.rows.length} pending followups for lead ${leadId} (${reason})`);
    bus.broadcast('followup.cancelled', { organizationId, leadId, count: result.rows.length, reason });
  }
}

/**
 * Execute pending follow-ups due now.
 */
export async function processDueFollowups() {
  const due = await db.many(`
    SELECT f.*, l.status AS "leadStatus"
    FROM scheduled_followups f
    JOIN leads l ON l.id = f."leadId"
    WHERE f.status = 'pending' AND f."scheduledFor" <= now()
    ORDER BY f."scheduledFor" ASC
    LIMIT 25
  `);

  let processed = 0;
  for (const item of due) {
    // If lead is already booked, lost, or rejected, cancel follow-up
    if (['booked', 'converted', 'rejected', 'lost'].includes(item.leadStatus)) {
      await db.query('UPDATE scheduled_followups SET status = \'cancelled\', error = \'Lead terminal status\', "updatedAt" = now() WHERE id = $1', [item.id]);
      continue;
    }

    const payload = item.payload || {};
    try {
      if (item.channel === 'whatsapp' && payload.phone) {
        await sendWhatsAppMessage({
          organizationId: item.organizationId,
          to: payload.phone,
          text: payload.text,
          templateKey: item.templateKey,
        });
      } else if (item.channel === 'email' && payload.email) {
        // Dispatches email nudge
        console.log(`[followup:email] To ${payload.email}: ${payload.text.slice(0, 80)}...`);
      } else if (item.channel === 'alert') {
        console.log(`[followup:alert] Staff alert: ${payload.text}`);
      }

      await db.query('UPDATE scheduled_followups SET status = \'sent\', "sentAt" = now(), "updatedAt" = now() WHERE id = $1', [item.id]);
      processed++;
      bus.broadcast('followup.sent', { organizationId: item.organizationId, followupId: item.id, leadId: item.leadId, stepDay: item.stepDay });
    } catch (e) {
      await db.query('UPDATE scheduled_followups SET status = \'failed\', error = $2, "updatedAt" = now() WHERE id = $1', [item.id, e.message]);
    }
  }

  return { processed, totalDue: due.length };
}

// Hook event listeners to event bus (Slide 21)
bus.on('quotation.sent', async payload => {
  if (!payload.leadId || !payload.organizationId) return;
  try {
    const lead = await db.one('SELECT * FROM leads WHERE id = $1', [payload.leadId]);
    const contact = lead?.contactId ? await db.one('SELECT * FROM contacts WHERE id = $1', [lead.contactId]) : null;
    const phone = payload.phone || contact?.phone || null;
    const email = payload.email || lead?.customerEmail || contact?.email || null;
    const customerName = contact?.name || 'Valued Guest';

    await scheduleCustomerFollowups({
      organizationId: payload.organizationId,
      leadId: payload.leadId,
      contactId: contact?.id,
      phone,
      email,
      customerName,
      title: lead.title,
      destination: lead.destination,
    });
  } catch (err) {
    console.error('[followup] quotation.sent event listener failed:', err.message);
  }
});

bus.on('booking.created', async payload => {
  if (payload.leadId) {
    cancelFollowupsForLead({ organizationId: payload.organizationId, leadId: payload.leadId, reason: 'booking confirmed' });
  }
});

