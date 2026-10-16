// lib/plivo-xml.mjs — what our answer_url replies with when Plivo answers a call.
//
// This is the Plivo XML vocabulary (Speak, Play, Dial, Record, Hangup, Wait), trimmed to what the
// holiday desk needs. Plivo drives the call entirely from this XML: if it is malformed or unreachable,
// the call connects to silence and nothing is ever recorded — so the webhook routes must be publicly
// reachable and must answer with content-type application/xml.

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const attrs = o => Object.entries(o)
  .filter(([, v]) => v !== undefined && v !== null && v !== false)
  .map(([k, v]) => ` ${k}="${esc(v)}"`).join('');

/**
 * The call-control document.
 * @param {object} o
 * @param {string} [o.greeting]    spoken to the caller before anything else
 * @param {string} [o.language]    TTS language (default en-IN; guests often speak Tamil/Hindi)
 * @param {string} [o.voice]
 * @param {object} [o.dial]        bridge the call: { number | sip, callerId, timeLimit, action, record }
 * @param {object} [o.record]      take a message: { action, maxLength, transcriptionType }
 * @param {boolean} [o.hangup]     close the call after the above
 */
export function answerXml(o = {}) {
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<Response>'];
  if (o.greeting) parts.push(`  <Speak${attrs({ language: o.language || 'en-IN', voice: o.voice })}>${esc(o.greeting)}</Speak>`);
  if (o.play) parts.push(`  <Play>${esc(o.play)}</Play>`);
  if (o.dial) {
    const d = o.dial;
    const isSip = String(d.number || d.sip || '').includes('@') || String(d.number || d.sip || '').startsWith('sip:');
    const target = d.number || d.sip;
    parts.push(`  <Dial${attrs({
      callerId: d.callerId,
      timeLimit: d.timeLimit,
      action: d.action,
      method: d.action ? 'POST' : undefined,
      record: d.record === true ? 'true' : (d.record || undefined),
      callbackUrl: d.callbackUrl,
      callbackMethod: d.callbackUrl ? 'POST' : undefined,
      redirect: d.redirect,
    })}>`);
    parts.push(`    <${isSip ? 'User' : 'Number'}${attrs({ sendDigits: d.sendDigits })}>${esc(target)}</${isSip ? 'User' : 'Number'}>`);
    parts.push('  </Dial>');
  }
  if (o.record) {
    const r = o.record;
    parts.push(`  <Record${attrs({
      action: r.action,
      method: r.action ? 'POST' : undefined,
      maxLength: r.maxLength || 300,
      playBeep: r.playBeep === false ? 'false' : 'true',
      transcriptionType: r.transcriptionType,
      transcriptionUrl: r.transcriptionUrl,
      startOnDialAnswer: r.startOnDialAnswer,
      recordChannelType: r.recordChannelType || 'mono',
    })} />`);
  }
  if (o.wait) parts.push(`  <Wait${attrs({ length: o.wait })} />`);
  if (o.hangup) parts.push(`  <Hangup${attrs({ reason: o.reason })} />`);
  parts.push('</Response>');
  return parts.join('\n');
}

/** A short acknowledgement Plivo accepts for webhooks that are not driving the call. */
export const emptyXml = () => '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
