import { Client } from 'pg';
import * as dotenv from 'dotenv';
dotenv.config();

// Phase 14 (SRCH-01): post-deploy verification for the pg_trgm extension and
// the two CONCURRENTLY-built GIN trigram indexes. Safe to run against prod —
// read-only queries against pg_extension / pg_index / pg_indexes.
// Exits 0 if everything is healthy, 1 otherwise (so it can gate a runbook).
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('[verify-trgm] DATABASE_URL not set');
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const problems: string[] = [];

  try {
    const ext = await client.query<{ extname: string; extversion: string }>(
      "SELECT extname, extversion FROM pg_extension WHERE extname = 'pg_trgm'",
    );
    if (ext.rows.length === 0) {
      problems.push('pg_trgm extension is NOT installed');
    } else {
      console.log(`[verify-trgm] extension pg_trgm v${ext.rows[0].extversion} installed`);
    }

    const expected = [
      { name: 'messages_content_trgm_idx', table: 'messages' },
      { name: 'conversations_group_name_trgm_idx', table: 'conversations' },
    ];

    const rows = await client.query<{
      indexname: string;
      tablename: string;
      indisvalid: boolean;
      indisready: boolean;
      size: string;
    }>(
      `SELECT i.indexname,
              i.tablename,
              x.indisvalid,
              x.indisready,
              pg_size_pretty(pg_relation_size(c.oid)) AS size
         FROM pg_indexes i
         JOIN pg_class c ON c.relname = i.indexname
         JOIN pg_index x ON x.indexrelid = c.oid
        WHERE i.indexname = ANY($1::text[])`,
      [expected.map((e) => e.name)],
    );

    const found = new Map(rows.rows.map((r) => [r.indexname, r]));
    for (const e of expected) {
      const r = found.get(e.name);
      if (!r) {
        problems.push(`index ${e.name} on ${e.table} is MISSING`);
        continue;
      }
      if (r.tablename !== e.table) {
        problems.push(`index ${e.name} is on table ${r.tablename}, expected ${e.table}`);
      }
      if (!r.indisvalid) {
        problems.push(`index ${e.name} exists but indisvalid=false (CONCURRENTLY build was interrupted — DROP and rebuild)`);
      }
      if (!r.indisready) {
        problems.push(`index ${e.name} exists but indisready=false`);
      }
      if (r.indisvalid && r.indisready) {
        console.log(`[verify-trgm] index ${e.name} on ${e.table} valid (${r.size})`);
      }
    }
  } finally {
    await client.end();
  }

  if (problems.length > 0) {
    console.error('\n[verify-trgm] FAIL:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  console.log('\n[verify-trgm] OK — extension installed, both indexes valid');
}

main().catch((err) => {
  console.error('[verify-trgm]', err);
  process.exit(1);
});
