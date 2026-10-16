// The office API — one router per desk, mounted under /api.
import express from 'express';
import { officeRouter } from './office.mjs';
import { pipelineRouter } from './pipeline.mjs';
import { contactsRouter } from './contacts.mjs';
import { callsRouter } from './calls.mjs';
import { recordingsRouter } from './recordings.mjs';
import { transcriptionsRouter } from './transcriptions.mjs';
import { leadsRouter } from './leads.mjs';
import { suppliersRouter } from './suppliers.mjs';
import { staffRouter } from './staff.mjs';
import { numbersRouter } from './numbers.mjs';
import { auditRouter } from './audit.mjs';
import { plivoRouter } from './plivo.mjs';
import { webhooksRouter } from './webhooks.mjs';

// Phase 2 Modules
import { quotesRouter } from './quotes.mjs';
import { versionsRouter } from './versions.mjs';
import { followupsRouter } from './followups.mjs';
import { bookingsRouter } from './bookings.mjs';
import { travellerCareRouter } from './travellerCare.mjs';
import { zowizRouter } from './zowiz.mjs';
import { modulesRouter } from './modules.mjs';

export function createApiRouter() {
  const r = express.Router();

  r.use('/', officeRouter());
  r.use('/pipeline', pipelineRouter());
  r.use('/contacts', contactsRouter());
  r.use('/calls', callsRouter());
  r.use('/recordings', recordingsRouter());
  r.use('/transcriptions', transcriptionsRouter());
  r.use('/leads', leadsRouter());
  r.use('/suppliers', suppliersRouter());
  r.use('/staff', staffRouter());
  r.use('/numbers', numbersRouter());
  r.use('/audit', auditRouter());
  r.use('/plivo', plivoRouter());
  r.use('/webhooks', webhooksRouter());

  // Phase 2 module endpoints
  r.use('/quotes', quotesRouter());
  r.use('/versions', versionsRouter());
  r.use('/followups', followupsRouter());
  r.use('/bookings', bookingsRouter());
  r.use('/care', travellerCareRouter());
  r.use('/zowiz', zowizRouter());
  r.use('/modules', modulesRouter());

  return r;
}
