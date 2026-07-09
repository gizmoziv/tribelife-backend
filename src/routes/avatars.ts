import { Router } from 'express';
import { createCanvas } from '@napi-rs/canvas';

// ── Initials-avatar image service (Phase A — Sender-Avatar Notifications) ────
// PUBLIC endpoint (no requireAuth): the iOS NSE / Android Notifee layers fetch
// it unauthenticated to render a WhatsApp-style avatar fallback when a sender
// has no uploaded photo. NO DATABASE ACCESS — everything is derived from the
// request path (`:userId`, digits only) and the `?h=<handle>` query param. The
// response is an immutable-cached raster PNG so OS/CDN serve repeats.

const router = Router();

// Fixed palette of ~10 pleasant, saturated colors. A handle deterministically
// hashes to one entry so a given user always gets the same background color.
const PALETTE = [
  '#E4572E', // vermilion
  '#F3A712', // amber
  '#4C9F70', // green
  '#2E86AB', // blue
  '#7B5EA7', // violet
  '#D64550', // rose
  '#0FA3B1', // teal
  '#C1666B', // clay
  '#3D5A80', // slate blue
  '#B5651D', // ochre
];

/**
 * First up-to-2 alphanumeric characters of the handle, uppercased. Falls back
 * to '?' when the handle has no alphanumerics (or is empty).
 */
function deriveInitials(handle: string): string {
  const cleaned = handle.replace(/[^a-zA-Z0-9]/g, '');
  if (cleaned.length === 0) return '?';
  return cleaned.slice(0, 2).toUpperCase();
}

/**
 * Deterministic FNV-1a hash of the handle → stable palette index. Empty handle
 * maps to the first palette entry.
 */
function colorForHandle(handle: string): string {
  if (handle.length === 0) return PALETTE[0];
  let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < handle.length; i++) {
    hash ^= handle.charCodeAt(i);
    // FNV prime multiply, kept in 32-bit range via Math.imul.
    hash = Math.imul(hash, 0x01000193);
  }
  const idx = (hash >>> 0) % PALETTE.length;
  return PALETTE[idx];
}

// GET /api/avatars/initials/:userId.png?h=<handle>
router.get('/initials/:userId([0-9]+).png', (req, res) => {
  const handle = String(req.query.h ?? '');
  const initials = deriveInitials(handle);
  const color = colorForHandle(handle);

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

  // Centered white bold initials.
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 110px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(initials, size / 2, size / 2 + 6);

  const buf = canvas.toBuffer('image/png');
  res.type('image/png');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(buf);
});

export default router;
