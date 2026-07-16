import logger from './logger';

// ── Shared structured moderation logger ─────────────────────────────────────
// All moderation surfaces (image/voice/text) MUST log through this helper so
// field names never drift — these fields are shipped to OpenSearch as
// structured, indexable fields (never string-interpolated into the message).

export interface ModerationLogFields {
  surface: 'image' | 'voice' | 'text' | 'document';
  action: 'quarantined' | 'hard_deleted' | 'rejected' | 'allowed_low_confidence';
  senderId: number;
  mediaUrl?: string;
  quarantineKey?: string;
  category?: string;
  confidence?: number;
  reason?: string;
  messageId?: number;
  roomId?: string;
}

export function logModerationEvent(fields: ModerationLogFields): void {
  logger.child({ module: 'moderation' }).info({ event: 'moderation_block', ...fields }, 'moderation block');
}
