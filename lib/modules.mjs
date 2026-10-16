// Module Registry and Plug-and-Play Manager (Slides 13, 14, 20)
import { db, orgId, newId } from '../db/index.mjs';

export const MODULE_CATALOG = [
  // --- CORE PLATFORM ---
  {
    id: 'core',
    name: 'Core Platform',
    category: 'core',
    version: '1.0.0',
    description: 'Contacts, leads, calls, whisper transcription, telephony vault, and module manager.',
    installed: true,
    required: true,
    screens: ['office', 'calls', 'transcriptions', 'pipeline'],
    events: ['call.completed', 'transcription.created', 'lead.created'],
  },

  // --- SHARED MODULES (Reusable across any industry) ---
  {
    id: 'messaging',
    name: 'Messaging Hub',
    category: 'shared',
    version: '1.0.0',
    description: 'Unified WhatsApp Business and Email dispatch with delivery confirmation and templates.',
    installed: true,
    screens: ['despatch'],
    events: ['message.sent', 'message.delivered', 'message.replied'],
  },
  {
    id: 'followup',
    name: 'Follow-up Automation',
    category: 'shared',
    version: '1.0.0',
    description: 'Automated chasing cadence (Day 0, 2, 5, 10) for customers and unresponsive suppliers.',
    installed: true,
    screens: ['followups'],
    events: ['followup.scheduled', 'followup.sent', 'followup.cancelled'],
  },
  {
    id: 'leads',
    name: 'Lead Qualification & Status',
    category: 'shared',
    version: '1.0.0',
    description: 'Auto-qualification from transcripts and multi-stage status tracking (New to Booked/Lost).',
    installed: true,
    screens: ['pipeline', 'leads'],
    events: ['lead.qualified', 'lead.status_changed'],
  },
  {
    id: 'payments',
    name: 'Booking & Payment Reminders',
    category: 'shared',
    version: '1.0.0',
    description: 'Booking handover, instalment schedules, and automated payment milestone reminders.',
    installed: true,
    screens: ['bookings'],
    events: ['booking.created', 'payment.due', 'payment.received'],
  },
  {
    id: 'traveller_care',
    name: 'Traveller Care & Feedback',
    category: 'shared',
    version: '1.0.0',
    description: 'Pre-departure packs, post-trip feedback surveys, and repeat customer marketing.',
    installed: true,
    screens: ['care'],
    events: ['departure.prepped', 'feedback.requested', 'feedback.received'],
  },

  // --- TRAVEL PACK (Domain-Specific for Travel Agencies) ---
  {
    id: 'quotation',
    name: 'Quotation Engine',
    category: 'travel',
    version: '1.0.0',
    description: 'Multi-supplier quote comparison, staff margin markup calculation, and winning quote selection.',
    installed: true,
    screens: ['quotes'],
    events: ['quote.received', 'quote.selected', 'pricing.updated'],
  },
  {
    id: 'flights',
    name: 'Flights & Final Quotation',
    category: 'travel',
    version: '1.0.0',
    description: 'Manual and live flight details, itinerary merging, and branded customer quotation documents.',
    installed: true,
    screens: ['flights', 'design'],
    events: ['flights.added', 'quotation.sent'],
  },
  {
    id: 'revisions',
    name: 'Revisions & Version History',
    category: 'travel',
    version: '1.0.0',
    description: 'Full audit history of changes across v1, v2, v3 iterations with snapshot restores.',
    installed: true,
    screens: ['revisions'],
    events: ['lead.revised', 'version.created'],
  },
  {
    id: 'visa',
    name: 'Visa Document Checklist',
    category: 'travel',
    version: '1.0.0',
    description: 'Destination-based visa rules, required documents tracking, and verification status.',
    installed: true,
    screens: ['visa'],
    events: ['visa.doc_uploaded', 'visa.verified'],
  },

  // --- OPTIONAL INTEGRATION ---
  {
    id: 'zowiz',
    name: 'Zowiz Marketing CRM Link',
    category: 'shared',
    version: '1.0.0',
    description: 'Bi-directional sync with Zowiz: pull inbound marketing leads and push customer/booking status.',
    installed: true,
    screens: ['zowiz'],
    events: ['zowiz.lead_pulled', 'zowiz.status_pushed'],
  },
];

/**
 * Ensure default modules are registered in module_registry table for the organization.
 */
export async function syncModuleRegistry() {
  const organizationId = await orgId();
  for (const mod of MODULE_CATALOG) {
    await db.query(`
      INSERT INTO module_registry ("id", "organizationId", "moduleId", "name", "category", "version", "installed", "settings")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT ("organizationId", "moduleId")
      DO UPDATE SET "name" = EXCLUDED."name", "category" = EXCLUDED."category", "version" = EXCLUDED."version"
    `, [newId(), organizationId, mod.id, mod.name, mod.category, mod.version, mod.installed, JSON.stringify({})]);
  }
}

/**
 * Get active installed modules for the organization.
 */
export async function getInstalledModules() {
  const organizationId = await orgId();
  const rows = await db.many(`
    SELECT "moduleId", "name", "category", "version", "installed", "settings", "installedAt"
    FROM module_registry
    WHERE "organizationId" = $1
    ORDER BY "category", "name"
  `, [organizationId]);
  return rows;
}

