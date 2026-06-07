/**
 * Minimal ambient declaration for tz-lookup (no official @types package).
 * tzlookup(lat, lon) → IANA timezone string, e.g. "America/Los_Angeles".
 * Throws for out-of-range coordinates.
 */
declare module 'tz-lookup' {
  function tzlookup(lat: number, lon: number): string;
  export = tzlookup;
}
