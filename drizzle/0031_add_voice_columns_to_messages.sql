ALTER TABLE "messages" ADD COLUMN "voice_url" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "voice_duration_ms" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "voice_waveform" jsonb;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "voice_transcript" text;