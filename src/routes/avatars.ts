import { Router } from 'express';
import { createCanvas } from '@napi-rs/canvas';

// ── Initials-avatar image service (Phase A — Sender-Avatar Notifications) ────
// PUBLIC endpoint (no requireAuth): the iOS NSE / Android Notifee layers fetch
// it unauthenticated to render a WhatsApp-style avatar fallback when a sender
// has no uploaded photo. NO DATABASE ACCESS — everything is derived from the
// request path (`:userId`, digits only) and the `?h=<name>` query param. The
// response is an immutable-cached raster PNG so OS/CDN serve repeats.
//
// Letter + color derivation MIRRORS the mobile in-app avatar exactly
// (tribelife-mobile/components/ui/AvatarCircle.tsx): a single uppercase initial
// and a 36-color djb2-style hash. This guarantees a no-image group renders the
// SAME initial and SAME background color in the notification tray as in the app.
// The only deliberate divergence is the letter fill (always white here, since a
// tray image cannot follow the recipient's light/dark theme).

const router = Router();

// 36-color palette, copied verbatim (exact order) from AvatarCircle.tsx. The
// modulo index depends on array order, so this MUST stay byte-identical to the
// mobile source of truth.
const AVATAR_COLORS = [
  '#E53E3E', // red
  '#38A169', // green
  '#3182CE', // blue
  '#D69E2E', // gold
  '#805AD5', // purple
  '#DD6B20', // orange
  '#319795', // teal
  '#D53F8C', // pink
  '#2B6CB0', // navy
  '#C05621', // brown
  '#00B5D8', // cyan
  '#9F7AEA', // violet
  '#276749', // forest
  '#E53E9F', // magenta
  '#B7791F', // amber
  '#2C7A7B', // dark teal
  '#6B46C1', // deep purple
  '#C53030', // crimson
  '#2F855A', // emerald
  '#4C51BF', // indigo
  '#ED8936', // tangerine
  '#667EEA', // periwinkle
  '#48BB78', // lime green
  '#ED64A6', // hot pink
  '#4FD1C5', // aqua
  '#F56565', // coral
  '#68D391', // mint
  '#FC8181', // salmon
  '#76E4F7', // sky blue
  '#F6AD55', // peach
  '#B794F4', // lavender
  '#63B3ED', // steel blue
  '#FBD38D', // sand
  '#F687B3', // rose
  '#81E6D9', // seafoam
  '#FEB2B2', // blush
];

/**
 * Deterministic djb2-style hash of the name → stable palette index. Mirrors
 * AvatarCircle.tsx's getAvatarColor exactly so a given name always maps to the
 * same background color both in-app and in the notification tray.
 */
function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

/**
 * Single uppercase initial — the first character of the name, uppercased. No
 * alphanumeric stripping (so "Test Group" → "T", not "TE"). Mirrors the mobile
 * AvatarCircle rule.
 */
function deriveInitial(name: string): string {
  return name.charAt(0).toUpperCase();
}

// GET /api/avatars/initials/:userId.png?h=<name>
router.get('/initials/:userId([0-9]+).png', (req, res) => {
  // Derive BOTH the initial and the color from the SAME safeName string, exactly
  // as AvatarCircle.tsx does. Empty/missing name falls back to '?'.
  const rawName = String(req.query.h ?? '');
  const safeName = rawName && rawName.length > 0 ? rawName : '?';
  const initial = deriveInitial(safeName);
  const color = getAvatarColor(safeName);

  const size = 256;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Transparent background outside the circle.
  ctx.clearRect(0, 0, size, size);

  // Filled circle in the hashed color.
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();

  // Centered white bold initial. White (not theme text) is deliberate: a tray
  // image cannot follow the recipient's light/dark theme.
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 110px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(initial, size / 2, size / 2 + 6);

  const buf = canvas.toBuffer('image/png');
  res.type('image/png');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(buf);
});

export default router;
