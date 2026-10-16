// The office roster — who works the holiday desk.
//
// This is the real pipeline, in the order work moves through it:
//
//   CALL DESK → RECORDING VAULT → TRANSCRIPTION → TRIP DESIGN → APPROVAL GATE → DESPATCH
//
// with the DIRECTORY pod in the middle holding the records every desk works from (contacts, leads,
// suppliers, staff). Each agent owns one desk, and clicking the agent opens it.

// 3dots design tokens (https://3dots.co/)
export const TOKENS = {
  brand: '#258C7B',
  brandDark: '#1B6C5F',
  brandLight: '#34B39E',
  brandSurface: '#EBF7F5',
  cream: '#F4F6FB',
  surface: '#FFFFFF',
  ink: '#0F172A',
  grey: '#64748B',
  hairline: 'rgba(226, 232, 240, 0.9)',
};

export const DEPT_KEYS = ['calls', 'record', 'scribe', 'design', 'gate', 'despatch', 'desk'];

export const DEPTS = {
  calls:    { name: 'CALL DESK',       short: 'CALLS',       chip: '#258C7B', ink: '#1B6C5F', floor: '#EBF7F5', what: 'dials the guest and records the call' },
  record:   { name: 'RECORDING VAULT', short: 'RECORDINGS',  chip: '#06B6D4', ink: '#0E7490', floor: '#ECFEFF', what: 'collects the audio Plivo recorded' },
  scribe:   { name: 'TRANSCRIPTION',   short: 'TRANSCRIPTS', chip: '#8B5CF6', ink: '#6D28D9', floor: '#F5F3FF', what: 'turns the recording into text' },
  design:   { name: 'TRIP DESIGN',     short: 'TRIP DESIGN', chip: '#F59E0B', ink: '#B45309', floor: '#FEF9EE', what: 'writes the itinerary from the transcript' },
  gate:     { name: 'APPROVAL GATE',   short: 'APPROVALS',   chip: '#EC4899', ink: '#BE185D', floor: '#FDF2F8', what: 'nothing leaves the building until a person signs it off' },
  despatch: { name: 'DESPATCH',        short: 'DESPATCH',    chip: '#10B981', ink: '#047857', floor: '#ECFDF5', what: 'mails the guest and the suppliers' },
  desk:     { name: 'DIRECTORY',       short: 'DIRECTORY',   chip: '#0F172A', ink: '#258C7B', floor: '#F1F5F9', what: 'the records every desk works from' },
};

/** The team. `desk` is the panel an agent opens when clicked. */
export const AGENTS = [
  // CALL DESK — place the call, run it, keep the lines
  { id: 'dialer', name: 'DIALER', dept: 'calls', lead: true, desk: 'calls', grid: [0.5, 0], hair: '#3b2b1d', skin: '#F0C9A0' },
  { id: 'phone', name: 'DESK PHONE', dept: 'calls', desk: 'phone', grid: [0, 1], hair: '#111111', skin: '#C68B59' },
  { id: 'lines', name: 'NUMBERS', dept: 'calls', desk: 'numbers', grid: [1, 1], hair: '#7a3b12', skin: '#F5D5B0' },

  // RECORDING VAULT
  { id: 'archivist', name: 'ARCHIVIST', dept: 'record', lead: true, desk: 'recordings', grid: [0.5, 0.5], hair: '#101820', skin: '#B07850' },

  // TRANSCRIPTION
  { id: 'scribe', name: 'SCRIBE', dept: 'scribe', lead: true, desk: 'transcriptions', grid: [0.5, 0.5], hair: '#26140a', skin: '#E8B98E' },

  // TRIP DESIGN
  { id: 'designer', name: 'ITINERARY DESIGNER', dept: 'design', lead: true, desk: 'leads', grid: [0, 0], hair: '#5a2d0c', skin: '#F0C9A0' },
  { id: 'pricer', name: 'QUOTES & PRICING', dept: 'design', desk: 'quotes', grid: [1, 0], hair: '#2a1a0e', skin: '#E8B98E' },
  { id: 'reviser', name: 'REVISIONS', dept: 'design', desk: 'revisions', grid: [1, 1], hair: '#1c1c2e', skin: '#E0A878' },

  // APPROVAL GATE
  { id: 'gatekeeper', name: 'APPROVALS', dept: 'gate', lead: true, desk: 'approvals', grid: [0.5, 0.5], hair: '#1f1f1f', skin: '#F0C9A0' },

  // DESPATCH
  { id: 'courier', name: 'CLIENT MAIL', dept: 'despatch', lead: true, desk: 'despatch', grid: [0, 0], hair: '#3d2814', skin: '#E8B98E' },
  { id: 'chaser', name: 'FOLLOW-UPS', dept: 'despatch', desk: 'followups', grid: [1, 0], hair: '#141414', skin: '#D9A97E' },
  { id: 'rfq', name: 'SUPPLIER RFQ', dept: 'despatch', desk: 'suppliers', grid: [1, 1], hair: '#101820', skin: '#C68B59' },

  // DIRECTORY — the records
  { id: 'contacts', name: 'CONTACTS', dept: 'desk', lead: true, desk: 'contacts', grid: [0, 0], hair: '#2a1a0e', skin: '#F5D5B0' },
  { id: 'leads', name: 'LEADS', dept: 'desk', desk: 'pipeline', grid: [1, 0], hair: '#141414', skin: '#D9A97E' },
  { id: 'partners', name: 'SUPPLIERS', dept: 'desk', desk: 'suppliers', grid: [0, 1], hair: '#2e2118', skin: '#E8B98E' },
  { id: 'team', name: 'STAFF & TEAMS', dept: 'desk', desk: 'staff', grid: [1, 1], hair: '#0d0d0d', skin: '#9C6B43' },
];

export const LAYOUT = {
  calls:    { pos: [-34, -26], w: 20, d: 22 },
  record:   { pos: [0, -52],   w: 18, d: 16 },
  scribe:   { pos: [34, -26],  w: 18, d: 16 },
  design:   { pos: [34, 26],   w: 20, d: 22 },
  gate:     { pos: [0, 52],    w: 18, d: 16 },
  despatch: { pos: [-34, 26],  w: 20, d: 22 },
  desk:     { pos: [0, 0],     w: 20, d: 20 },
};

/** The order the pipeline flows: the walkways are drawn pod to pod, and back to the directory. */
export const FLOW = ['calls', 'record', 'scribe', 'design', 'gate', 'despatch'];

/** Which agent a pod's badge opens. */
export const POD_LEAD = {
  calls: 'dialer',
  record: 'archivist',
  scribe: 'scribe',
  design: 'designer',
  gate: 'gatekeeper',
  despatch: 'courier',
  desk: 'contacts',
};

/** The desks: what the panel is called and what it is for. */
export const DESKS = {
  calls:         { title: 'CALL DESK',        pod: 'calls',    blurb: 'Dial a contact, watch the call, and pull what the carrier recorded.' },
  phone:         { title: 'DESK PHONE',       pod: 'calls',    blurb: 'Register the Plivo SIP line in this page and talk to the guest yourself.' },
  numbers:       { title: 'NUMBERS',          pod: 'calls',    blurb: 'The lines the office answers on: search, buy, bind, release.' },
  recordings:    { title: 'RECORDING VAULT',  pod: 'record',   blurb: 'Every call Plivo recorded, with playback and one-click transcription.' },
  transcriptions:{ title: 'TRANSCRIPTS',      pod: 'scribe',   blurb: 'What was said on the call, written out by OpenAI Whisper.' },
  design:        { title: 'TRIP DESIGN',      pod: 'design',   blurb: 'Read a transcript, design the itinerary, keep every version with the call.' },
  leads:         { title: 'TRIP DESIGN',      pod: 'design',   blurb: 'Read a transcript, design the itinerary, keep every version with the call.' },
  revisions:     { title: 'REVISIONS',        pod: 'design',   blurb: 'Itineraries staff sent back with notes, waiting to be reworked.' },
  approvals:     { title: 'APPROVAL GATE',    pod: 'gate',     blurb: 'Nothing is mailed until a person signs the file off.' },
  despatch:      { title: 'DESPATCH',         pod: 'despatch', blurb: 'The guest itinerary and the supplier RFQ, with the PDF attached.' },
  contacts:      { title: 'CONTACTS',         pod: 'desk',     blurb: 'Everyone the office can call. Pick one here, then dial it.' },
  pipeline:      { title: 'LEADS',            pod: 'desk',     blurb: 'Every case and which station it is sitting at.' },
  suppliers:     { title: 'SUPPLIERS',        pod: 'despatch', blurb: 'The hotels, transport and activity partners we quote.' },
  staff:         { title: 'STAFF & TEAMS',    pod: 'desk',     blurb: 'Who works the desk, and which team they sit on.' },
  audit:         { title: 'AUDIT',            pod: 'desk',     blurb: 'What the office did, and to what.' },
  quotes:        { title: 'QUOTATION ENGINE', pod: 'design',   blurb: 'Capture supplier quotes, compare side-by-side, add margin, and calculate selling price.' },
  followups:     { title: 'FOLLOW-UP AUTOMATION', pod: 'despatch', blurb: 'Automated Day 2, 5, 10 WhatsApp & Email chasing cadence for customers and suppliers.' },
  bookings:      { title: 'BOOKINGS & PAYMENTS', pod: 'desk', blurb: 'Confirmed booking handover, payment instalment schedules, and WhatsApp reminders.' },
  care:          { title: 'TRAVELLER CARE & VISA', pod: 'desk', blurb: 'Destination visa checklists, pre-departure document packs, and post-trip feedback.' },
  modules:       { title: 'MODULE MANAGER & ZOWIZ', pod: 'desk', blurb: 'Plug-and-play module configuration and Zowiz Marketing CRM integration.' },
};
