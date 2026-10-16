# 3dots Travel — the holiday desk

A travel agency's back office, shown as a 3D office floor and wired to the real work: a call goes out
through Plivo, the recording comes back, OpenAI Whisper writes it down, a model turns it into an
itinerary, a **person** approves it, and then the guest and the suppliers get their mail with the PDF
attached.

Nothing here is a mock. Every desk reads and writes the same PostgreSQL database, the same Plivo
account, the same recordings and the same mail provider.

```
npm start                 # -> http://localhost:4300
npm run build             # rebuild public/index.html after editing src/
npm run smoke             # every desk, end to end (read-only), against a running office
```

## The pipeline

The floor is laid out in the order work moves. Each station is a pod, and each agent owns a desk you
open by clicking them.

| # | Pod | What it does | Desk |
|---|---|---|---|
| 1 | **CALL DESK** | dial a contact through Plivo, watch the call, run live controls | `calls` · `phone` · `numbers` |
| 2 | **RECORDING VAULT** | pull the audio Plivo recorded, play it back through a signed link | `recordings` |
| 3 | **TRANSCRIPTION** | OpenAI Whisper, chunked for telephony audio, hallucination-pruned | `transcriptions` |
| 4 | **TRIP DESIGN** | read the transcript, write the itinerary, rework it on staff notes | `leads` · `revisions` |
| 5 | **APPROVAL GATE** | **the gate** — nothing outbound until a person signs it off | `approvals` |
| 6 | **DESPATCH** | email the guest the itinerary PDF and the suppliers the RFQ PDF | `despatch` |
| — | **DIRECTORY** (centre) | the records every desk works from | `contacts` · `pipeline` · `suppliers` · `staff` |

The board is a projection of the data, not a separate table: a case is one call with everything
attached to it, and each station's state is computed from the call, the recording, the transcription
and the lead (`api/pipeline.mjs`). The office and the database therefore cannot disagree.

## The office floor

Seven pods, in the order work moves, with the **dotted wires** showing which outside service feeds
which pod. Hover a service chip (or a pod) to trace its wires and light the pods it serves:

```
                     Plivo ──────▶ CALLS · RECORDINGS
                     Whisper ────▶ TRANSCRIPTS
                     DeepSeek ───▶ TRIP DESIGN
                     Resend ─────▶ DESPATCH
                     Travel DB ──▶ every pod
```

Clicking an agent, a pod card or the pod strip opens that desk. Everything the desks show comes from
the office's own database, so the numbers on the cards are the real ones and refresh every 6 seconds.

**On a phone** the floor is navigated with the pod strip under the header (the office is wider than a
phone screen, and 118 px pod cards cannot all fit at once): tap a pod to fly there and open its desk,
pinch to zoom, drag to pan. Desk panels go full-screen with the nav as a swipeable tab strip, wide
record tables scroll sideways, and forms open as bottom sheets.

**Type** is the 3dots stack — `system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter"`
with `"SF Mono", Menlo, Consolas` for figures and ids — so nothing has to be downloaded and the
numbers line up in columns.

**Every record carries its created-at** (contacts "Added", calls "Created" + "Called", recordings
"Created" + "Call", transcripts, leads and cases "Created" + "Updated", suppliers, staff "Joined",
numbers, and the audit ledger), so the newest row is always identifiable at a glance.

## What is real

- **Real:** the calls and their Plivo uuids, the recordings and their audio, the Whisper transcripts
  (including Tamil), the generated itineraries, the approval gate, the emails and their PDFs, the
  audit trail, and every record the desks edit.
- **Real money:** buying a number charges your Plivo account; sending mail costs Resend.
- **Guarded:** `/api/webhooks/*` verifies Plivo's V3 signature when `PLIVO_WEBHOOK_AUTH_TOKEN` is set,
  books the raw payload for idempotency, and never throws at the carrier.
- **Not simulated:** there is no scripted engine left in this repository.

Two things the office is deliberately honest about:

- **Mail with no key** is composed in full and reported as `simulated` rather than silently dropped.
  The despatch desk says so on the page, and the audit entry records `simulated: true`.
- **A failed send keeps its reason.** If Resend refuses an address, the ledger holds the provider's
  own message instead of claiming success.

## Where things live

```
travel-office/
  server.mjs              express: the office page + the API
  db/index.mjs            the pg pool, .env loading, the organization scope
  lib/plivo.mjs           Plivo REST (calls, recordings, numbers, applications, XML call control)
  lib/plivo-signature.mjs Plivo V3 webhook signature, computed the way the SDK does
  lib/transcribe.mjs      OpenAI Whisper: carrier fetch, 25 s chunking, hallucination pruning
  lib/itinerary.mjs       the trip designer (OpenAI, falling back to DeepSeek)
  lib/mail.mjs            the two mails (Resend REST) + the templates
  lib/pdf.mjs             the itinerary / RFQ PDF
  lib/media.mjs           short-lived signed playback links
  lib/audit.mjs           the ledger every action writes to
  api/                    one router per desk; api/index.mjs mounts them under /api
  src/                    the 3D office (data.js roster, main.js scene, desks.js panels)  tools/smoke.mjs         the end-to-end check
  public/index.html       the built page (generated — do not edit)
```

## The API

```bash
curl -s localhost:4300/api/office            # the dashboard: counts, services, waiting approvals
curl -s localhost:4300/api/pipeline          # the six stations and where every case stands
curl -s localhost:4300/api/contacts          # add with POST { name, phone, email?, company?, notes? }
curl -s localhost:4300/api/suppliers         # add with POST { name, category, email, contactPerson? }
curl -s localhost:4300/api/staff             # add with POST { name, email, role }
curl -s -X POST localhost:4300/api/calls -H 'content-type: application/json' \
     -d '{"contactId":"…","mode":"message"}'          # mode: message (greet + record) | browser (talk)
curl -s localhost:4300/api/recordings        # the vault; each row carries a signed playUrl
curl -s -X POST localhost:4300/api/recordings/<id>/transcribe     # Whisper
curl -s -X POST localhost:4300/api/leads/generate -d '{"callId":"…"}'   # design the trip
curl -s -X POST localhost:4300/api/leads/<id>/approve             # the staff sign-off
curl -s -X POST localhost:4300/api/leads/<id>/send -d '{"supplierId":"…"}'   # both mails + PDFs
curl -s localhost:4300/api/leads/<id>/pdf?type=customer           # what goes out, on its own
```

Plivo answers a call by asking this office for XML: `POST /api/webhooks/plivo/answer` (add
`?mode=browser` to bridge the guest to the SIP line registered in the page), `…/ring`, `…/record` and
`…/hangup`. Those paths must be publicly reachable — set `PUBLIC_BASE_URL` to your tunnel, and the
office warns if Plivo cannot reach it before it dials.

## Configuration

`.env` (see the keys the app reads):

| Key | For |
|---|---|
| `DATABASE_URL` | the PostgreSQL database this office works on |
| `ORG_SLUG` | which organization to work as (defaults to the one with the most calls) |
| `PLIVO_AUTH_ID` · `PLIVO_AUTH_TOKEN` · `PLIVO_CALLER_ID` | the Plivo account |
| `PLIVO_SIP_ENDPOINT` · `PLIVO_ENDPOINT_PASSWORD` | the browser desk phone |
| `PLIVO_WEBHOOK_AUTH_TOKEN` | verifying inbound webhooks (strongly recommended) |
| `PUBLIC_BASE_URL` | the public URL Plivo calls back |
| `OPENAI_API_KEY` | Whisper transcription |
| `DEEPSEEK_API_KEY` · `DEEPSEEK_BASE_URL` · `DEEPSEEK_MODEL` | itinerary generation |
| `RESEND_API_KEY` · `RESEND_FROM_EMAIL` | the two mails |
| `MEDIA_URL_SECRET` · `MEDIA_URL_TTL_SECONDS` | signing recording playback |
| `PORT` | the office page (default 4300) |

The top bar shows which of these are live; a service that is not configured shows grey rather than
pretending to be wired.

## Driving it

1. `npm start`, open the page. The pods carry the office's real numbers.
2. **CONTACTS** (directory pod) → add the guest you are about to call.
3. **CALL DESK** → pick that contact, choose *message* (greet + record) or *talk from this browser*,
   and dial. Plivo answers the call with this office's XML.
4. **RECORDING VAULT** → the audio lands here on its own; press play, then **TRANSCRIBE**.
5. **TRIP DESIGN** → pick the transcribed call and **WRITE THE ITINERARY**.
6. **APPROVAL GATE** → read the document, then **APPROVE**, **SEND BACK WITH NOTES** or **REJECT**.
7. **DESPATCH** → mail the guest and choose the supplier for the RFQ; both PDFs are attached, and the
   audit desk records exactly what happened.
