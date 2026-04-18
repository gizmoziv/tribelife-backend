-- Phase 2 ENRICH-06 / ENRICH-07: news_config seeds for LLM enrichment
-- D-10 preserved_terms (JSONB array of 31 proper nouns, prompt-only enforcement)
-- D-12 seed list sourced from 02-RESEARCH.md §Preserved-Terms Seed List
-- D-14 enrichment_daily_cap_usd = 0.50 (operator-editable; $0.50/day gives ~5x headroom on worst-case ingest volume per 02-RESEARCH.md §Pitfall 6)
-- D-15 enrichment_usage_today seed uses epoch date so the first LLM call triggers UTC rollover and resets to today

INSERT INTO "news_config" ("key", "value") VALUES
  ('preserved_terms',             '["Netanyahu","Gantz","Lapid","Ben Gvir","Smotrich","Herzog","Knesset","Likud","IDF","Shin Bet","Mossad","Jerusalem","Tel Aviv","Gaza","West Bank","Golan","Hamas","Hezbollah","Houthis","Iran","Palestinian Authority","Biden","Trump","Harris","UN","ICC","ICJ","Shabbat","Torah","Yom Kippur","Rosh Hashanah"]'::jsonb),
  ('enrichment_daily_cap_usd',    '0.50'::jsonb),
  ('enrichment_usage_today',      '{"date":"1970-01-01","cents_spent":0,"breaker_tripped":false}'::jsonb);
