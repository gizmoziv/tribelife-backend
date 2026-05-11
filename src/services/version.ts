/**
 * Semver-style numeric version comparison for the force-update gate.
 * Parses 'X.Y.Z' into { major, minor, patch }, compares major → minor → patch.
 *
 * Pre-release tags (e.g. '1.4.3-beta.1') are not used by TribeLife.
 * If introduced later, this parser strips the suffix and compares base only.
 *
 * Returns:
 *  -1 if a < b
 *   0 if a == b (also returned when either input is unparseable — fail-open)
 *   1 if a > b
 *
 * Test cases (D-06):
 *   compareVersions('1.4.3', '1.4.3') === 0
 *   compareVersions('1.4.3', '1.4.2') === 1
 *   compareVersions('1.4.3', '1.5.0') === -1
 *   compareVersions('2.0.0', '1.99.99') === 1
 *   compareVersions('garbage', '1.0.0') === 0  (unparseable → fail-open)
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
  return 0;
}

function parseVersion(v: string): { major: number; minor: number; patch: number } | null {
  if (typeof v !== 'string') return null;
  // Strip pre-release suffix if present (e.g. '1.4.3-beta.1' → '1.4.3')
  const base = v.split('-')[0];
  const parts = base.split('.');
  if (parts.length !== 3) return null;
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  const patch = Number(parts[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;
  if (major < 0 || minor < 0 || patch < 0) return null;
  return { major, minor, patch };
}
