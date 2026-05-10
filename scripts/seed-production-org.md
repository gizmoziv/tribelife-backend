# Seed Production Organization (ORG-06)

Operationally seed the FIRST production organization end-to-end. Required by ORG-06 of the
v1.5 Authorization & Tiers milestone. Run AFTER Phase 5 plans 05-01 through 05-08 are merged
and deployed.

**What this runbook does:**
1. Inserts one row into `organizations` (the org itself).
2. Inserts one `organization_memberships` row with `role='admin'` for the designated admin user.
3. Inserts at least one `organization_memberships` row with `role='member'` for a non-admin.
4. Verifies the capability round-trip end-to-end via curl.
5. Walks through the manual UX checklist (admin sees org in profile section, public org page
   renders at `/org/{slug}`, non-admin member sees Leave organization CTA only).

No new HTTP endpoint. No `is_staff` flag. No schema change.

---

## Pre-flight

### 1. Confirm Phase 5 backend is deployed

```bash
curl -s https://api.tribelife.app/api/orgs/_does_not_exist_ | jq .
```

Expected: `{ "error": "Organization not found" }` or `{ "error": "Invalid slug" }`

If `401` is returned → the public router is not mounted; the deployment is incomplete. Stop and
redeploy before continuing.

### 2. Confirm both designated user IDs exist

```sql
SELECT id, email FROM users WHERE id IN (<admin_user_id>, <member_user_id>);
-- Expected: 2 rows.
```

### 3. Confirm the Phase 2 unique constraints are in place

The SQL in this runbook relies on two specific constraints from migration
`drizzle/0012_organization_schema.sql`. Verify them before running the seed:

```sql
\d+ organizations
-- Expected output includes:
--   "organizations_slug_unique" UNIQUE CONSTRAINT, btree (slug)
```

```sql
\d+ organization_memberships
-- Expected output includes:
--   "organization_memberships_org_user_unique" UNIQUE, btree (org_id, user_id)
```

If either constraint is missing, migration `drizzle/0012_organization_schema.sql` did not apply.
STOP and reconcile before running the seed.

Constraint reference (verified at planning time against `drizzle/0012_organization_schema.sql`):
- Line 35: `CONSTRAINT "organizations_slug_unique" UNIQUE("slug")` — table constraint, supports
  `ON CONFLICT (slug)`
- Line 46: `CREATE UNIQUE INDEX "organization_memberships_org_user_unique" ON
  "organization_memberships" USING btree ("org_id","user_id")` — unique index, supports
  `ON CONFLICT (org_id, user_id)`

PostgreSQL accepts `ON CONFLICT` against both forms via the conflict-target column-list syntax.

### 4. Pick concrete values and record them here

Fill in before running — copy-paste into the SQL below:

| Parameter | Value |
|---|---|
| Org slug | `<slug>` — 3-30 chars, pattern `[a-z0-9-]`, e.g. `brooklyn-jewish-centers` |
| Org name | `<name>` — 1-100 chars, Hebrew/emoji-friendly, e.g. `Brooklyn Jewish Centers` |
| Org type | one of: `jcc` / `non_profit` / `creator` / `community` / `business` |
| Admin user_id | `<admin_user_id>` (integer, confirmed in pre-flight step 2) |
| Non-admin member user_id | `<member_user_id>` (integer, confirmed in pre-flight step 2) |
| Description (optional) | `<description>` or `NULL` |
| Icon URL (optional) | `<icon_url>` — full CDN URL, or `NULL` (upload via `/api/upload/org-icon-url` after seeding) |

---

## Seed SQL

Run as a single transaction. Idempotent on slug uniqueness — re-running with the same slug is a
no-op for the org row, and re-running with the same `(org_id, user_id)` pair is a no-op for
each membership row.

The `ON CONFLICT` clauses reference column-list conflict targets (not constraint names).
PostgreSQL matches them against the verified Phase 2 constraints:
- `organizations_slug_unique` UNIQUE("slug") supports `ON CONFLICT (slug)`
- `organization_memberships_org_user_unique` UNIQUE INDEX (org_id, user_id) supports
  `ON CONFLICT (org_id, user_id)`

```sql
BEGIN;

-- Step 1: Insert org (idempotent via organizations_slug_unique)
INSERT INTO organizations (slug, name, type, description, icon_url)
VALUES (
  '<slug>',
  '<name>',
  '<type>',
  <'description text' or NULL>,
  <'https://cdn.example.com/icon.png' or NULL>
)
ON CONFLICT (slug) DO NOTHING
RETURNING id;
-- Save the returned id as :ORG_ID.
-- If the INSERT was a no-op (org already existed), look it up manually:
--   SELECT id FROM organizations WHERE slug = '<slug>';
```

```sql
-- Step 2: Insert admin membership (idempotent via organization_memberships_org_user_unique)
INSERT INTO organization_memberships (org_id, user_id, role)
VALUES (:ORG_ID, <admin_user_id>, 'admin')
ON CONFLICT (org_id, user_id) DO NOTHING;
```

```sql
-- Step 3: Insert non-admin member (idempotent via organization_memberships_org_user_unique)
INSERT INTO organization_memberships (org_id, user_id, role)
VALUES (:ORG_ID, <member_user_id>, 'member')
ON CONFLICT (org_id, user_id) DO NOTHING;
```

```sql
-- Step 4: Sanity check — verify org + membership counts before committing
SELECT
  o.id,
  o.slug,
  o.name,
  o.type,
  (SELECT COUNT(*) FROM organization_memberships WHERE org_id = o.id) AS member_count,
  (SELECT COUNT(*) FROM organization_memberships WHERE org_id = o.id AND role = 'admin') AS admin_count
FROM organizations o
WHERE o.id = :ORG_ID;
-- Expected: 1 row, member_count >= 2, admin_count >= 1.

COMMIT;
```

---

## Verification — Capability Round-Trip (ORG-03 + ORG-06)

Both designated users must have valid bearer tokens. Generate via Google Sign-In on a test
device, or via the dev mint helper if available.

```bash
export ADMIN_TOKEN=<admin_user_jwt>
export MEMBER_TOKEN=<member_user_jwt>
```

### 1. Admin capability snapshot

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://api.tribelife.app/api/auth/capabilities | jq .capabilities
```

Expected:

```json
{
  "tier": "org_admin",
  "isPremium": false,
  "orgs": [
    {
      "orgId": "<ORG_ID>",
      "role": "admin",
      "slug": "<slug>",
      "name": "<name>",
      "iconUrl": null
    }
  ],
  "limits": { "maxOrgsOwned": 1 },
  "features": { "canCreateOrg": false }
}
```

The `tier` field MUST read `"org_admin"` — this confirms the capability axis (Plan 05-01) is
wired correctly to the `organization_memberships` row.

### 2. Member capability snapshot

```bash
curl -s -H "Authorization: Bearer $MEMBER_TOKEN" \
  https://api.tribelife.app/api/auth/capabilities | jq .capabilities
```

Expected:

```json
{
  "tier": "free",
  "orgs": [
    {
      "orgId": "<ORG_ID>",
      "role": "member",
      "slug": "<slug>",
      "name": "<name>",
      "iconUrl": null
    }
  ]
}
```

Note: `tier` stays `"free"` for non-admin members. Per Phase 4 D-10 (personal-axis split),
the `org_admin` tier is granted only to users with at least one `role='admin'` membership.

### 3. Public per-org endpoint (auth-aware)

```bash
# Anonymous (no Authorization header):
curl -s https://api.tribelife.app/api/orgs/<slug> | jq .org
# Expected: { id, slug, name, type, iconUrl, memberCount: 2, isMember: false, role: null }

# Admin:
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://api.tribelife.app/api/orgs/<slug> | jq .org
# Expected: same fields PLUS isMember: true, role: "admin"

# Member:
curl -s -H "Authorization: Bearer $MEMBER_TOKEN" \
  https://api.tribelife.app/api/orgs/<slug> | jq .org
# Expected: isMember: true, role: "member"
```

---

## Manual Verification Checklist (per CONTEXT D-08)

Run on a production iOS or Android build (not simulator — Universal Link verification requires
the installed bundle ID + AASA file, see Plan 05-10 for AASA deployment confirmation).

- [ ] **Admin sees org in profile section.** Sign in as the admin user → Profile tab →
      "YOUR ORGANIZATIONS" section visible with one OrgCard showing the new org name + Admin
      RoleBadge. Tap → routes to `/org/<slug>` authenticated-member admin variant (shows
      Manage members / Edit org / Invite people actions).

- [ ] **Public org page accessible at `/org/{slug}`.** Open
      `https://tribelife.app/org/<slug>` on a device with the app installed → Universal Link
      routes into the app → renders the per-org screen. If not logged in, the anonymous
      variant renders ("Sign in to view" CTA). Open the same URL in a desktop browser →
      renders the marketing-page placeholder (no app).

- [ ] **Non-admin member sees Leave organization CTA only.** Sign in as the seeded member user
      → Profile tab shows the OrgCard with Member RoleBadge → tap → per-org screen
      authenticated-member variant → only "Leave organization" PillButton renders (no Manage /
      Invite / Edit actions, per D-05 role table).

Tick each box AFTER personally completing the action on a real device.

---

## Rollback

If the seed produces an unwanted org or membership, soft-delete instead of hard-deleting:

```sql
-- Soft-delete (preferred): org disappears from caps.orgs[] on next refresh.
-- getOrgMembershipsForUser filters by isNull(organizations.deletedAt) — see Plan 05-01.
UPDATE organizations SET deleted_at = now() WHERE id = :ORG_ID;
```

Hard-delete is reserved for accidental seeds caught immediately (before any user interaction):

```sql
DELETE FROM organization_memberships WHERE org_id = :ORG_ID;
DELETE FROM organizations WHERE id = :ORG_ID;
```

If a membership row is wrong (wrong role, wrong user) but the org itself is correct:

```sql
-- Remove one membership (no org soft-delete needed):
DELETE FROM organization_memberships WHERE org_id = :ORG_ID AND user_id = <user_id>;

-- Or update role:
UPDATE organization_memberships SET role = 'admin' WHERE org_id = :ORG_ID AND user_id = <user_id>;
```

---

## Sign-off

Record after completing all pre-flight, seed SQL, verification curls, and manual checklist.
Copy this block into `05-10-VERIFICATION.md`.

| Field | Value |
|---|---|
| Operator | (your name) |
| Date (UTC) | YYYY-MM-DD |
| Org slug | `<slug>` |
| Org id | `<ORG_ID>` |
| Admin user_id | `<admin_user_id>` |
| Member user_id | `<member_user_id>` |
| Backend SHA at seed | `git -C tribelife-backend rev-parse HEAD` |
| Mobile build version | (from `app.json` `expo.version`) |
| All 3 manual checklist boxes ticked? | yes / no |
