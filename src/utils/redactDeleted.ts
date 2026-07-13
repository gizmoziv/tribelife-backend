/**
 * Redact soft-deleted messages in a history read projection.
 *
 * Delete-for-everyone keeps the row (so clients render a "message deleted"
 * tombstone in place, WhatsApp-style) but the actual content must never reach
 * the client. Given rows that include a `deletedAt` field, this strips content,
 * media, mentions, and voice payloads from any deleted row while leaving
 * everything else (id, sender, createdAt, kind, deletedAt) intact so the
 * client can position the tombstone and pick the right label.
 */
export function redactDeletedMessages<
  T extends {
    deletedAt?: Date | string | null;
    content?: string;
    mediaUrls?: unknown;
    mentions?: unknown;
    voiceUrl?: string | null;
    voiceDurationMs?: number | null;
    voiceWaveform?: unknown;
    voiceTranscript?: string | null;
  },
>(rows: T[]): T[] {
  return rows.map((row) =>
    row.deletedAt
      ? {
          ...row,
          content: '',
          mediaUrls: null,
          mentions: [],
          voiceUrl: null,
          voiceDurationMs: null,
          voiceWaveform: null,
          voiceTranscript: null,
        }
      : row,
  );
}
