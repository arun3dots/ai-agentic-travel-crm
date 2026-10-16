// Phase 2 Schema Migrations — safe, non-destructive DDL
import { db } from './index.mjs';

export async function runMigrations() {
  console.log('[db] verifying Phase 2 schema migrations...');

  // 1. Add Phase 2 columns to `leads` if not present
  await db.query(`
    ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS flights jsonb DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS pricing jsonb DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS qualification jsonb DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS "lostReason" text,
      ADD COLUMN IF NOT EXISTS "currentVersion" integer DEFAULT 1,
      ADD COLUMN IF NOT EXISTS "quotationSentAt" timestamp without time zone;
  `);

  // 2. Table: supplier_quotes (Module 1: Quotation Engine)
  await db.query(`
    CREATE TABLE IF NOT EXISTS supplier_quotes (
      id text PRIMARY KEY,
      "organizationId" text NOT NULL,
      "leadId" text NOT NULL,
      "supplierId" text NOT NULL,
      "quoteAmount" numeric(12,2) NOT NULL,
      currency text DEFAULT 'INR',
      "staffMarginPercent" numeric(5,2) DEFAULT 10.00,
      "finalSellingPrice" numeric(12,2),
      notes text,
      source text DEFAULT 'email',
      status text DEFAULT 'received',
      "quoteUrl" text,
      "createdAt" timestamp without time zone DEFAULT now(),
      "updatedAt" timestamp without time zone DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_supplier_quotes_lead ON supplier_quotes("leadId");
  `);

  // 3. Table: lead_versions (Module 3: Revisions & Version History)
  await db.query(`
    CREATE TABLE IF NOT EXISTS lead_versions (
      id text PRIMARY KEY,
      "organizationId" text NOT NULL,
      "leadId" text NOT NULL,
      "versionNumber" integer NOT NULL,
      title text,
      destination text,
      itinerary text,
      flights jsonb DEFAULT '[]'::jsonb,
      pricing jsonb DEFAULT '{}'::jsonb,
      notes text,
      author text DEFAULT 'Staff',
      "createdAt" timestamp without time zone DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_lead_versions_lead ON lead_versions("leadId");
  `);

  // 4. Table: scheduled_followups (Module 5: Follow-up Automation)
  await db.query(`
    CREATE TABLE IF NOT EXISTS scheduled_followups (
      id text PRIMARY KEY,
      "organizationId" text NOT NULL,
      "leadId" text NOT NULL,
      "contactId" text,
      "targetType" text DEFAULT 'customer',
      "targetId" text,
      channel text DEFAULT 'whatsapp',
      "stepDay" integer DEFAULT 2,
      "scheduledFor" timestamp without time zone NOT NULL,
      status text DEFAULT 'pending',
      "templateKey" text,
      payload jsonb DEFAULT '{}'::jsonb,
      "sentAt" timestamp without time zone,
      error text,
      "createdAt" timestamp without time zone DEFAULT now(),
      "updatedAt" timestamp without time zone DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_followups_lead ON scheduled_followups("leadId");
    CREATE INDEX IF NOT EXISTS idx_followups_scheduled ON scheduled_followups(status, "scheduledFor");
  `);

  // 5. Table: bookings (Module 7: Booking & Payments)
  await db.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id text PRIMARY KEY,
      "organizationId" text NOT NULL,
      "leadId" text NOT NULL,
      "contactId" text,
      "bookingReference" text NOT NULL,
      status text DEFAULT 'confirmed',
      "totalAmount" numeric(12,2) DEFAULT 0,
      currency text DEFAULT 'INR',
      "paidAmount" numeric(12,2) DEFAULT 0,
      "startDate" timestamp without time zone,
      "endDate" timestamp without time zone,
      "handoverNotes" text,
      "assignedStaffId" text,
      "createdAt" timestamp without time zone DEFAULT now(),
      "updatedAt" timestamp without time zone DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_bookings_lead ON bookings("leadId");
  `);

  // 6. Table: payment_schedules (Module 7: Payment reminders)
  await db.query(`
    CREATE TABLE IF NOT EXISTS payment_schedules (
      id text PRIMARY KEY,
      "organizationId" text NOT NULL,
      "bookingId" text NOT NULL,
      "leadId" text,
      title text NOT NULL,
      amount numeric(12,2) NOT NULL,
      "dueDate" timestamp without time zone NOT NULL,
      status text DEFAULT 'pending',
      "paidAt" timestamp without time zone,
      "paymentMethod" text,
      "transactionRef" text,
      "reminderSentAt" timestamp without time zone,
      "createdAt" timestamp without time zone DEFAULT now(),
      "updatedAt" timestamp without time zone DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_payment_schedules_booking ON payment_schedules("bookingId");
  `);

  // 7. Table: visa_checklists (Module 8: Visa Checklist)
  await db.query(`
    CREATE TABLE IF NOT EXISTS visa_checklists (
      id text PRIMARY KEY,
      "organizationId" text NOT NULL,
      "leadId" text NOT NULL,
      "bookingId" text,
      destination text,
      "documentName" text NOT NULL,
      status text DEFAULT 'required',
      "fileUrl" text,
      notes text,
      "createdAt" timestamp without time zone DEFAULT now(),
      "updatedAt" timestamp without time zone DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_visa_checklists_lead ON visa_checklists("leadId");
  `);

  // 8. Table: traveller_care (Module 8: Pre-departure, Feedback, Repeat Marketing)
  await db.query(`
    CREATE TABLE IF NOT EXISTS traveller_care (
      id text PRIMARY KEY,
      "organizationId" text NOT NULL,
      "leadId" text NOT NULL,
      "bookingId" text,
      type text NOT NULL,
      status text DEFAULT 'pending',
      "scheduledFor" timestamp without time zone,
      "sentAt" timestamp without time zone,
      rating integer,
      "feedbackText" text,
      notes text,
      "createdAt" timestamp without time zone DEFAULT now(),
      "updatedAt" timestamp without time zone DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_traveller_care_lead ON traveller_care("leadId");
  `);

  // 9. Table: module_registry (Architecture: Plug-and-play modules)
  await db.query(`
    CREATE TABLE IF NOT EXISTS module_registry (
      id text PRIMARY KEY,
      "organizationId" text NOT NULL,
      "moduleId" text NOT NULL,
      name text NOT NULL,
      category text NOT NULL,
      version text NOT NULL,
      installed boolean DEFAULT true,
      settings jsonb DEFAULT '{}'::jsonb,
      "installedAt" timestamp without time zone DEFAULT now(),
      CONSTRAINT uq_org_module UNIQUE ("organizationId", "moduleId")
    );
  `);

  console.log('[db] Phase 2 schema migrations complete.');
}

