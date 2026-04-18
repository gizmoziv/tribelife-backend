# TribeLife Backend

## Multi-instance Socket.IO verification (SCALE-05)

Phase 1 of v1.4 wires `@socket.io/redis-adapter` so backend pods broadcast Socket.IO events across
instances. Because there is no automated test suite, verification is manual. Two protocols — pre-deploy
local smoke test + post-deploy production log check — together satisfy SCALE-01..05.

### Local 2-pod smoke test (pre-deploy)

Prerequisite: Docker running.

```bash
# 1. Boot local Valkey
docker compose -f docker-compose.valkey.yml up -d

# 2. Wait for healthy
until docker inspect --format='{{.State.Health.Status}}' tribelife-valkey-dev | grep -q healthy; do sleep 1; done

# 3. Start pod A on port 4000 (in terminal 1)
REDIS_URL=redis://localhost:6379 PORT=4000 NODE_ENV=development npm run dev

# 4. Start pod B on port 4001 (in terminal 2)
REDIS_URL=redis://localhost:6379 PORT=4001 NODE_ENV=development npm run dev
```

**Expected boot logs** (pino pretty-printed in dev):
- Both pods log `msg: "Redis adapter ready"` with `url` field showing `redis://localhost:6379` (no password to redact).
- Both pods log `msg: "Redis pub ready"` and `msg: "Redis sub ready"`.

**Cross-pod broadcast check** (SCALE-01):
1. Connect mobile app (or `wscat` / socket.io-client) with valid JWT to `ws://localhost:4000/socket.io/?EIO=4&transport=websocket`.
2. Connect a second client to `ws://localhost:4001/socket.io/?EIO=4&transport=websocket`.
3. Client A sends a `room:message` (any content). Both clients must see it.
4. Repeat with a `conversation:` room (DM), a `globe:*` room, and a `user:*` targeted event.

**Fail-fast checks** (SCALE-04) — run each, expect non-zero exit and the matching pino `msg`:
```bash
# Unreachable Redis in production mode
REDIS_URL=rediss://invalid:25061 NODE_ENV=production npm start
# Expect: {"msg":"Redis connection failed",...}  -> exit 1 after ~3.4 min (10-retry cap)

# Missing REDIS_URL in production mode
NODE_ENV=production npm start
# Expect: {"msg":"REDIS_URL not set in production",...}  -> exit 1 immediately

# Non-TLS URL in production mode
REDIS_URL=redis://localhost:6379 NODE_ENV=production npm start
# Expect: {"msg":"Production requires rediss:// URL for TLS",...}  -> exit 1 immediately
```

### Cleanup

```bash
docker compose -f docker-compose.valkey.yml down -v
```

### Post-deploy verification on DO App Platform (SCALE-05)

After merging to main and deploying:

1. In DO App Platform UI, confirm Managed Caching for Valkey is provisioned in the same region.
2. Add production `REDIS_URL` (rediss://...) as an app-level secret.
3. Trigger a fresh deploy.
4. In DO log stream, confirm BOTH pods log `"Redis adapter ready"` at boot (one line per pod).
5. Scale `instance_count` from 1 → 2 in DO App Platform settings. Trigger redeploy.
6. Live-tail the log stream. Each log line emitted by a pod tagged with its hostname — confirm DISTINCT
   hostnames for the same user's activity window (e.g., two different `timezone:America/New_York`
   room messages from the same user should appear, each with a different pod hostname prefix in the
   DO-injected metadata).
7. Optional: `curl https://api.tribelife.app/health` repeatedly — responses should round-robin between
   pods (observable only via hostname metadata, not response body).

**Red flags** (abort and rollback to `instance_count: 1` if observed):
- Log spam containing `transport not supported` or polling handshake 400s — indicates mobile clients
  on old build hitting websocket-only backend. Remediate by rolling back backend deploy until mobile
  adoption is confirmed, or reverting mobile transport change in a follow-up release.
- `"Redis connection failed"` logs immediately after deploy — indicates `REDIS_URL` misconfigured.
- Silent message delivery gap across pods — adapter did not attach cleanly; check for ordering bug
  between `connect()` and `io.adapter(createAdapter(...))`.
