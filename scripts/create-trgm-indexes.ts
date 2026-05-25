import { Client } from 'pg';
import * as dotenv from 'dotenv';
dotenv.config();

// Phase 14 (SRCH-01): out-of-band CONCURRENT trigram index build.
// Lives outside the drizzle migrator because CREATE INDEX CONCURRENTLY cannot
// run inside a transaction (PG error 25001) and drizzle-kit wraps every
// migration file in BEGIN/COMMIT. Idempotent — safe to re-run.
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('[trgm-indexes] DATABASE_URL not set');
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const statements: Array<{ label: string; sql: string }> = [
    {
      label: 'messages_content_trgm_idx',
      sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_content_trgm_idx ON messages USING GIN (content gin_trgm_ops)',
    },
    {
      label: 'conversations_group_name_trgm_idx',
      sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS conversations_group_name_trgm_idx ON conversations USING GIN (group_name gin_trgm_ops) WHERE is_group = true',
    },
  ];

  try {
    for (const { label, sql } of statements) {
      console.log(`[trgm-indexes] building ${label}…`);
      await client.query(sql);
      console.log(`[trgm-indexes] ${label} ready`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[trgm-indexes]', err);
  process.exit(1);
});
