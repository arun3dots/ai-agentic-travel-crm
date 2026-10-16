// The transcription desk — OpenAI Whisper, exactly the way the platform called it.
//
// Telephony audio is the hard case: an 8 kHz mono line with long silences, which makes Whisper loop
// on a phrase ("Thank you. Thank you. Thank you.") and, on longer calls, silently truncate. So the
// call is sliced into independent 25-second chunks, mono 16 kHz, and each chunk is transcribed on its
// own; the text is then reassembled. Silence artifacts are pruned twice — per chunk and on the join.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { env } from '../db/index.mjs';

const LANGUAGE_NAME_TO_ISO = {
  tamil: 'ta', english: 'en', hindi: 'hi', telugu: 'te', kannada: 'kn', malayalam: 'ml',
  marathi: 'mr', bengali: 'bn', gujarati: 'gu', punjabi: 'pa', urdu: 'ur', spanish: 'es',
  french: 'fr', german: 'de', italian: 'it', portuguese: 'pt', russian: 'ru', chinese: 'zh',
  mandarin: 'zh', cantonese: 'yue', japanese: 'ja', korean: 'ko', arabic: 'ar', turkish: 'tr',
  vietnamese: 'vi', thai: 'th', indonesian: 'id', dutch: 'nl', polish: 'pl', swedish: 'sv',
  tagalog: 'tl', filipino: 'tl',
};

/** "Tamil" · "ta-IN" · "ta" → "ta"; anything unrecognised → undefined (let Whisper detect). */
export function normalizeToIso639_1(input) {
  if (!input) return undefined;
  const raw = String(input).trim().toLowerCase();
  if (!raw || raw === 'auto' || raw === 'mixed') return undefined;
  if (LANGUAGE_NAME_TO_ISO[raw]) return LANGUAGE_NAME_TO_ISO[raw];
  const two = raw.split(/[-_]/)[0];
  if (two.length === 2 || two.length === 3) return two;
  return undefined;
}

// Whisper's silence hallucinations and repetition loops, in any script.
const HALLUCINATIONS = [
  /Subtitles by the Amara\.org community/gi,
  /Transcribed by https:\/\/otter\.ai/gi,
  /www\.[a-z0-9-]+\.[a-z]{2,}(\/[^\s]*)?/gi,
  /Thank you for watching/gi,
  /Please subscribe/gi,
  /Thanks for watching/gi,
  /Visit for more\.?/gi,
  /Visit [a-z0-9.-]+\.[a-z]{2,}/gi,
];

export function cleanHallucinations(text) {
  if (!text) return '';
  let cleaned = text;
  for (const p of HALLUCINATIONS) cleaned = cleaned.replace(p, '');

  const words = cleaned.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    for (let n = 6; n >= 1; n--) {
      let i = 0;
      while (i + 2 * n <= words.length) {
        const phrase = words.slice(i, i + n).join(' ').toLowerCase();
        let repeats = 1;
        while (i + (repeats + 1) * n <= words.length) {
          const next = words.slice(i + repeats * n, i + (repeats + 1) * n).join(' ').toLowerCase();
          if (next === phrase) repeats++; else break;
        }
        if (repeats >= 2) words.splice(i + n, (repeats - 1) * n);
        i++;
      }
    }
    cleaned = words.join(' ');
  }
  return cleaned.replace(/\s+/g, ' ').trim();
}

/**
 * Download the audio Plivo recorded. Carrier URLs are sometimes behind basic auth; if the first
 * attempt is refused, retry with the account credentials before giving up.
 */
export async function fetchAudioFromUrl(url, { fetchImpl = fetch } = {}) {
  const baseHeaders = { 'User-Agent': '3dots-travel-office/1.0', 'ngrok-skip-browser-warning': 'true' };
  let response = await fetchImpl(url, { headers: baseHeaders });

  if (!response.ok && (response.status === 401 || response.status === 403) && env.PLIVO_AUTH_ID && env.PLIVO_AUTH_TOKEN) {
    const basic = Buffer.from(`${env.PLIVO_AUTH_ID}:${env.PLIVO_AUTH_TOKEN}`).toString('base64');
    response = await fetchImpl(url, { headers: { ...baseHeaders, Authorization: `Basic ${basic}` } });
  }
  if (!response.ok) throw new Error(`could not download the recording: HTTP ${response.status} ${response.statusText}`);

  const contentType = response.headers.get('content-type') || '';
  if (/text\/html|application\/xhtml|application\/xml/.test(contentType)) {
    throw new Error(`the carrier returned a document (${contentType}) instead of audio — check the recording URL`);
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength < 1000) throw new Error(`the downloaded audio is only ${arrayBuffer.byteLength} bytes — it is empty or invalid`);

  const buffer = Buffer.from(arrayBuffer);
  let filename = (new URL(url).pathname.split('/').pop() || 'recording.mp3');
  if (!/\.(mp3|wav|m4a|ogg|webm|flac)$/i.test(filename)) filename += '.mp3';
  return { buffer, filename };
}

async function whisperRequest(audio, filename, options) {
  const apiKey = options.apiKey || env.OPENAI_API_KEY;
  if (!apiKey || !apiKey.trim()) throw new Error('OPENAI_API_KEY is not configured — the transcription desk cannot run');
  const baseUrl = (options.baseUrl || env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const file = new File([audio], filename, { type: filename.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg' });

  const send = async modelName => {
    const form = new FormData();
    form.append('file', file);
    form.append('model', modelName);
    form.append('response_format', 'verbose_json');
    form.append('temperature', String(options.temperature ?? 0));
    form.append('prompt', options.prompt || 'Travel consultation phone call discussing vacation destinations, flights, hotels, booking packages, family, budget.');
    const iso = normalizeToIso639_1(options.language);
    if (iso) form.append('language', iso);
    return fetch(`${baseUrl}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form });
  };

  const requested = options.model || env.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1';
  let response = await send(requested);

  if (!response.ok && (requested === 'large-v3' || requested === 'whisper-large-v3')) {
    const message = await response.clone().json().then(j => String(j?.error?.message || '').toLowerCase()).catch(() => '');
    if (message.includes('does not exist') || message.includes('model')) response = await send('whisper-1');
  }
  if (!response.ok) {
    const detail = await response.json().then(j => j?.error?.message).catch(() => null);
    throw new Error(`OpenAI Whisper error: ${detail || `HTTP ${response.status}`}`);
  }

  const data = await response.json();
  return { text: (data.text || '').trim(), language: data.language, duration: data.duration, segments: data.segments, rawPayload: data };
}

function audioDuration(filePath) {
  return new Promise(resolve => {
    const p = spawn('ffmpeg', ['-i', filePath]);
    let err = '';
    p.stderr.on('data', d => (err += d.toString()));
    p.on('close', () => {
      const m = err.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
      resolve(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0);
    });
    p.on('error', () => resolve(0));
  });
}

function sliceAudio(input, start, duration, out) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-y', '-ss', String(start), '-i', input, '-t', String(duration), '-ac', '1', '-ar', '16000', out]);
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`))));
    p.on('error', reject);
  });
}

async function transcribeChunked(inputPath, totalDuration, options, chunkSize = 25) {
  const dir = os.tmpdir();
  const texts = [];
  const segments = [];
  let language = normalizeToIso639_1(options.language);
  let id = 0;

  for (let start = 0; start < totalDuration; start += chunkSize) {
    const duration = Math.min(chunkSize, totalDuration - start);
    const chunkPath = path.join(dir, `chunk_${crypto.randomUUID()}.wav`);
    try {
      await sliceAudio(inputPath, start, duration, chunkPath);
      const result = await whisperRequest(await fs.readFile(chunkPath), `chunk_${start}.wav`, options);
      if (result.language && !language) language = result.language;

      const cleaned = cleanHallucinations(result.text);
      if (!cleaned) continue;
      texts.push(cleaned);
      if (result.segments?.length) {
        for (const s of result.segments) {
          const segText = cleanHallucinations(s.text);
          if (segText) segments.push({ id: id++, start: Math.round((start + (s.start || 0)) * 100) / 100, end: Math.round((start + (s.end || duration)) * 100) / 100, text: segText });
        }
      } else {
        segments.push({ id: id++, start, end: Math.round((start + duration) * 100) / 100, text: cleaned });
      }
    } catch (e) {
      console.warn(`[transcribe] chunk ${start}s–${start + duration}s skipped: ${e.message}`);
    } finally {
      await fs.unlink(chunkPath).catch(() => {});
    }
  }

  return {
    text: cleanHallucinations(texts.join(' ')),
    language,
    duration: totalDuration,
    segments,
    rawPayload: { chunksCount: texts.length, totalDuration, strategy: 'chunked-25s-mono-16k' },
  };
}

/**
 * Transcribe an audio buffer. Long telephony calls are chunked when ffmpeg is available; short clips
 * go straight to Whisper. Returns { text, language, duration, segments, rawPayload }.
 */
export async function transcribeAudio(audioBuffer, filename = 'recording.mp3', options = {}) {
  const buffer = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
  const transcriptionOptions = options;

  if (buffer.length > 50000) {
    const tempFile = path.join(os.tmpdir(), `audio_${crypto.randomUUID()}_${filename}`);
    try {
      await fs.writeFile(tempFile, buffer);
      const duration = await audioDuration(tempFile);
      if (duration > 30) {
        const chunked = await transcribeChunked(tempFile, duration, transcriptionOptions);
        if (chunked.text) return chunked;
      }
    } catch (e) {
      console.warn('[transcribe] chunking unavailable, transcribing in one pass:', e.message);
    } finally {
      await fs.unlink(tempFile).catch(() => {});
    }
  }

  const result = await whisperRequest(buffer, filename, transcriptionOptions);
  result.text = cleanHallucinations(result.text);
  return result;
}

/** Fetch a carrier recording and transcribe it in one call. */
export async function transcribeRecordingUrl(url, options = {}) {
  const { buffer, filename } = await fetchAudioFromUrl(url);
  return transcribeAudio(buffer, filename, options);
}

export const transcriptionConfigured = () => !!env.OPENAI_API_KEY;
