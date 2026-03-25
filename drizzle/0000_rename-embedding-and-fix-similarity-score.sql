-- Custom SQL migration: rename embedding -> keywords, convert similarityScore text -> numeric

-- Rename embedding -> keywords on beacons table
ALTER TABLE beacons RENAME COLUMN embedding TO keywords;

-- Convert similarityScore from text to numeric on beacon_matches table
-- Step 1: Add new numeric column
ALTER TABLE beacon_matches ADD COLUMN similarity_score_new numeric;

-- Step 2: Copy data (cast text to numeric, COALESCE handles any NULLs)
UPDATE beacon_matches SET similarity_score_new = COALESCE(similarity_score::numeric, 0);

-- Step 3: Drop old text column
ALTER TABLE beacon_matches DROP COLUMN similarity_score;

-- Step 4: Rename new column to original name
ALTER TABLE beacon_matches RENAME COLUMN similarity_score_new TO similarity_score;

-- Step 5: Re-add NOT NULL constraint
ALTER TABLE beacon_matches ALTER COLUMN similarity_score SET NOT NULL;
