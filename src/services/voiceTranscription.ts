import OpenAI, { toFile } from 'openai';
import logger from '../lib/logger';
import { moderateMessage } from './claude';
import { humanizeCategory } from './imageModeration';

const log = logger.child({ module: 'voice-transcription' });

// ── Voice Transcription Service ───────────────────────────────────────────────
// Wraps OpenAI gpt-4o-mini-transcribe with a 20s timeout and one manual retry
// on transient errors (D-07). Two-pass transcript moderation: sync English
// blocklist (moderateMessage) + multilingual omni-moderation-latest (D-04/D-05).

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Constants (exported for downstream reuse) ─────────────────────────────────

export const TRANSCRIPTION_TIMEOUT_MS = 20_000;  // 20s per D-07
export const TRANSCRIPTION_MAX_RETRIES = 1;       // one manual retry per D-07
export const VOICE_MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB per D-14
export const VOICE_MAX_DURATION_MS = 120_000;         // 120s per D-14

// ── Transient error classifier (D-07/D-08) ────────────────────────────────────
// Returns true only for timeout, network errors, and 5xx server errors.
// Permanent 4xx / 422 errors are NOT transient and must not be retried.

function isTransient(err: unknown): boolean {
  return (
    err instanceof OpenAI.APIConnectionTimeoutError ||
    err instanceof OpenAI.InternalServerError ||
    err instanceof OpenAI.APIConnectionError
  );
}

// ── transcribeWithRetry ───────────────────────────────────────────────────────
// Wraps the audio buffer with toFile (filename hint audio.m4a, type audio/m4a)
// and calls audio.transcriptions.create with model gpt-4o-mini-transcribe.
// Language is NOT specified so Whisper auto-detects (D-04: original language).
// Per-request options: timeout 20000ms, maxRetries 0 (manual retry owns the loop).
// Loops at most TRANSCRIPTION_MAX_RETRIES+1 times; retries once on transient
// errors; re-throws on permanent errors or exhausted retries (D-08 fail-closed).

export async function transcribeWithRetry(audioBuffer: Buffer): Promise<string> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= TRANSCRIPTION_MAX_RETRIES; attempt++) {
    try {
      const file = await toFile(audioBuffer, 'audio.m4a', { type: 'audio/m4a' });

      const result = await client.audio.transcriptions.create(
        {
          file,
          model: 'gpt-4o-mini-transcribe',
          response_format: 'json',
          // NOTE: No 'language' param — auto-detect original spoken language (D-04)
        },
        {
          timeout: TRANSCRIPTION_TIMEOUT_MS,
          maxRetries: 0, // disable SDK auto-retry; we do exactly one manual retry
        },
      );

      return result.text ?? '';
    } catch (err) {
      lastError = err;

      if (!isTransient(err) || attempt >= TRANSCRIPTION_MAX_RETRIES) {
        // Permanent error or retries exhausted — caller fails closed per D-08
        break;
      }

      log.warn({ err, attempt }, '[voice-transcription] transient error — retrying');
    }
  }

  throw lastError; // exhausted — bubble up for fail-closed handling
}

// ── moderateTranscript ────────────────────────────────────────────────────────
// Two-pass transcript moderation (D-04/D-05):
//   Pass 1: moderateMessage() — synchronous English blocklist (zero latency)
//   Pass 2: omni-moderation-latest — multilingual AI (free, ~100-300ms)
// Rejects if EITHER pass flags. Uses endpoint's own flagged boolean (D-05).
// IMPORTANT: moderations endpoint receives the transcript TEXT, never the audio URL.

export async function moderateTranscript(
  transcript: string,
): Promise<{ isAllowed: boolean; category?: string }> {
  // ── Pass 1: sync English blocklist ─────────────────────────────────────────
  const syncResult = moderateMessage(transcript);
  if (!syncResult.isAllowed) {
    log.info({ reason: syncResult.reason }, '[voice-transcription] blocklist flagged transcript');
    return { isAllowed: false, category: syncResult.reason };
  }

  // ── Pass 2: multilingual AI moderation ─────────────────────────────────────
  // Input is the transcript TEXT — NOT the audio URL (Pitfall 1 from research)
  const modResult = await client.moderations.create({
    model: 'omni-moderation-latest',
    input: transcript,
  });

  const result = modResult.results[0];
  if (result?.flagged) {
    const flaggedEntry = Object.entries(result.categories).find(([, v]) => v);
    const category = flaggedEntry
      ? humanizeCategory(flaggedEntry[0])
      : 'Policy violation';
    log.info({ category }, '[voice-transcription] omni-moderation flagged transcript');
    return { isAllowed: false, category };
  }

  return { isAllowed: true };
}
