// Shadow-mode gate for auto content-moderation ENFORCEMENT.
// When MODERATION_ENFORCEMENT_ENABLED !== 'true' the scanners still RUN and LOG
// (action:'shadow_would_block') so the internal team has OpenSearch visibility,
// but NO user-facing action fires (no message rejection, image quarantine/strip,
// voice deletion, beacon block, or user notification). CSAM hard-delete and
// reactive report-takedowns are enforced OUTSIDE this gate and are unaffected.
export function moderationEnforced(): boolean {
  return process.env.MODERATION_ENFORCEMENT_ENABLED === 'true';
}
