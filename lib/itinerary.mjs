// The trip design desk — turns a call transcript into a real itinerary and auto-qualification (Module 6)
import { env } from '../db/index.mjs';

const providers = () => [
  env.OPENAI_API_KEY && {
    name: 'openai',
    url: 'https://api.openai.com/v1/chat/completions',
    key: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL || 'gpt-4o-mini',
  },
  env.DEEPSEEK_API_KEY && {
    name: 'deepseek',
    url: `${(env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '')}/chat/completions`,
    key: env.DEEPSEEK_API_KEY,
    model: env.DEEPSEEK_MODEL || 'deepseek-chat',
  },
].filter(Boolean);

export const itineraryConfigured = () => providers().length > 0;

async function complete({ messages, temperature = 0.7, timeoutMs = 60000, json = false }) {
  for (const p of providers()) {
    try {
      const body = { model: p.model, messages, temperature };
      if (json) body.response_format = { type: 'json_object' };
      const res = await fetch(p.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.warn(`[itinerary] ${p.name} (${p.model}) returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        continue;
      }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (content) return { content, provider: p.name, model: p.model };
    } catch (e) {
      console.warn(`[itinerary] ${p.name} failed: ${e.message}`);
    }
  }
  return null;
}

const SYSTEM_DESIGNER = `You are an elite bespoke travel concierge. Analyze the customer conversation transcript, determine the requested travel destination and preferences, and generate a comprehensive travel plan.

Return a strictly valid JSON object with the following keys:
- "title": A compelling title for the itinerary (e.g. "Bespoke 5-Day Romantic Escape to Florence" or "Luxury Family Journey in Dubai")
- "destination": The destination decided by you from the conversation (e.g. "Dubai, United Arab Emirates", "Tokyo, Japan", "Swiss Alps", "Kerala, India").
- "itinerary": The complete, elegant Markdown travel itinerary with sections: Executive Summary, Destination & Dates, Curated Accommodations, Day-by-Day Journey Schedule (Morning / Afternoon / Evening), Private Experiences & Inclusions, and Quotation Scope for Suppliers.
- "qualification": A JSON object containing:
    "estimatedBudget": estimated budget string or number (e.g. "₹1,50,000" or 150000),
    "travelDates": approximate season or dates mentioned (e.g. "Next month", "November 2026", "Mid-December"),
    "numberOfTravelers": integer or string (e.g. 2, "Family of 4"),
    "travelStyle": string (e.g. "Luxury Leisure", "Family Adventure", "Honeymoon", "Solo Cultural")`;

/** The transcript (+ who it was) → { title, destination, itinerary, qualification }. */
export async function generateItineraryFromTranscript(transcriptText, contact = {}) {
  const result = await complete({
    json: true,
    temperature: 0.7,
    messages: [
      { role: 'system', content: SYSTEM_DESIGNER },
      {
        role: 'user',
        content: `Customer Name: ${contact.name || 'Valued Client'}
Phone: ${contact.phone || 'N/A'}
Call Transcript:
${transcriptText}

Synthesize the travel plan and return the JSON object with "title", "destination", "itinerary", and "qualification".`,
      },
    ],
  });

  if (result) {
    try {
      const parsed = JSON.parse(result.content);
      if (parsed?.itinerary) {
        return {
          title: parsed.title || `${contact.name || 'Client'} - Bespoke Travel Itinerary`,
          destination: parsed.destination || 'Curated Destination',
          itinerary: parsed.itinerary,
          qualification: parsed.qualification || {
            estimatedBudget: 'On Request',
            travelDates: 'Upcoming Season',
            numberOfTravelers: 2,
            travelStyle: 'Bespoke Luxury',
          },
          provider: result.provider,
          model: result.model,
        };
      }
    } catch (e) {
      console.warn('[itinerary] the model did not return JSON, using its text as the document:', e.message);
      return {
        title: `${contact.name || 'Client'} - Bespoke Travel Itinerary`,
        destination: 'Curated Destination',
        itinerary: result.content,
        qualification: { estimatedBudget: 'On Request', travelDates: 'Upcoming', numberOfTravelers: 2, travelStyle: 'Custom' },
        provider: result.provider,
        model: result.model,
      };
    }
  }

  return { ...offlineItinerary(contact), provider: 'offline', model: null };
}

/** Staff notes → a revised itinerary document. */
export async function reviseItinerary(currentItinerary, correctionNotes) {
  const result = await complete({
    temperature: 0.5,
    messages: [
      { role: 'system', content: 'You are an expert travel concierge. Revise the provided travel itinerary according to the user corrections and requested adjustments. Preserve formatting and output the revised Markdown itinerary.' },
      { role: 'user', content: `Current Itinerary:\n${currentItinerary}\n\nRequested Corrections & Changes:\n${correctionNotes}\n\nProvide the complete updated and polished itinerary.` },
    ],
  });
  if (result?.content) return { itinerary: result.content, provider: result.provider, model: result.model };
  return {
    itinerary: `${currentItinerary}\n\n---\n### Revisions Applied\n* ${correctionNotes}\n*(Updated ${new Date().toLocaleDateString('en-IN')})*`,
    provider: 'offline',
    model: null,
  };
}

function offlineItinerary(contact = {}) {
  const clientName = contact.name || 'Valued Client';
  const title = 'Bespoke Travel Consultation Itinerary';
  const destination = 'Curated Luxury Destination';
  const itinerary = `# ${title}
**Prepared For:** ${clientName}
**Destination:** ${destination}
**Generated:** ${new Date().toLocaleDateString('en-IN')}

---

## 1. Executive Summary & Overview
Based on our consultation call, we are designing an exclusive private itinerary tailored to your schedule, preferences and travel party.

---

## 2. Next Steps
Our travel specialist will reach out shortly to review accommodation options, excursion preferences and supplier quotes.`;
  return {
    title,
    destination,
    itinerary,
    qualification: {
      estimatedBudget: '₹1,20,000',
      travelDates: 'November 2026',
      numberOfTravelers: 2,
      travelStyle: 'Bespoke Luxury',
    },
  };
}
