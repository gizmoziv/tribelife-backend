// ── Globe Room Configuration ────────────────────────────────────────────────
// Defines the 8 Globe rooms (1 global + 7 regional) with timezone mappings.

export interface GlobeRoom {
  slug: string;
  roomId: string;
  displayName: string;
  description: string;
  welcomeMessage: string;
  timezones: string[];
  isGlobal: boolean;
  sortOrder: number;
}

export const AGE_GATE_HOURS = 24;

export const GLOBE_ROOMS: GlobeRoom[] = [
  {
    slug: 'town-square',
    roomId: 'globe:town-square',
    displayName: 'Town Square',
    description: 'A global space for Jews worldwide to connect',
    welcomeMessage: 'Welcome to Town Square! This is a space for Jews worldwide to connect. Be kind, be respectful, and enjoy the conversation.',
    timezones: [],
    isGlobal: true,
    sortOrder: 0,
  },
  {
    slug: 'north-america',
    roomId: 'globe:north-america',
    displayName: 'North America',
    description: 'For the Jewish community in the US and Canada',
    welcomeMessage: 'Welcome to North America! This is a space for Jews in the US and Canada to connect. Be kind, be respectful, and enjoy the conversation.',
    timezones: [
      'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
      'America/Phoenix', 'America/Anchorage', 'America/Toronto', 'America/Vancouver',
      'America/Winnipeg', 'America/Edmonton', 'America/Halifax', 'Pacific/Honolulu',
    ],
    isGlobal: false,
    sortOrder: 1,
  },
  {
    slug: 'israel',
    roomId: 'globe:israel',
    displayName: 'Israel',
    description: 'For the Jewish community in Israel',
    welcomeMessage: 'Welcome to Israel! This is a space for Jews in Israel to connect. Be kind, be respectful, and enjoy the conversation.',
    timezones: ['Asia/Jerusalem'],
    isGlobal: false,
    sortOrder: 2,
  },
  {
    slug: 'europe',
    roomId: 'globe:europe',
    displayName: 'Europe',
    description: 'For the Jewish community across Europe',
    welcomeMessage: 'Welcome to Europe! This is a space for Jews in Europe to connect. Be kind, be respectful, and enjoy the conversation.',
    timezones: [
      'Europe/Paris', 'Europe/Berlin', 'Europe/Amsterdam', 'Europe/Brussels',
      'Europe/Rome', 'Europe/Madrid', 'Europe/Zurich', 'Europe/Vienna',
      'Europe/Stockholm', 'Europe/Oslo', 'Europe/Copenhagen', 'Europe/Helsinki',
      'Europe/Warsaw', 'Europe/Prague', 'Europe/Budapest', 'Europe/Bucharest',
      'Europe/Athens', 'Europe/Istanbul',
    ],
    isGlobal: false,
    sortOrder: 3,
  },
  {
    slug: 'uk-ireland',
    roomId: 'globe:uk-ireland',
    displayName: 'UK & Ireland',
    description: 'For the Jewish community in the UK and Ireland',
    welcomeMessage: 'Welcome to UK & Ireland! This is a space for Jews in the UK and Ireland to connect. Be kind, be respectful, and enjoy the conversation.',
    timezones: ['Europe/London', 'Europe/Dublin'],
    isGlobal: false,
    sortOrder: 4,
  },
  {
    slug: 'latin-america',
    roomId: 'globe:latin-america',
    displayName: 'Latin America',
    description: 'For the Jewish community in Latin America',
    welcomeMessage: 'Welcome to Latin America! This is a space for Jews in Latin America to connect. Be kind, be respectful, and enjoy the conversation.',
    timezones: [
      'America/Mexico_City', 'America/Bogota', 'America/Lima', 'America/Santiago',
      'America/Argentina/Buenos_Aires', 'America/Sao_Paulo', 'America/Caracas',
    ],
    isGlobal: false,
    sortOrder: 5,
  },
  {
    slug: 'australia-nz',
    roomId: 'globe:australia-nz',
    displayName: 'Australia/NZ',
    description: 'For the Jewish community in Australia and New Zealand',
    welcomeMessage: 'Welcome to Australia/NZ! This is a space for Jews in Australia and New Zealand to connect. Be kind, be respectful, and enjoy the conversation.',
    timezones: [
      'Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane',
      'Australia/Perth', 'Australia/Adelaide', 'Pacific/Auckland', 'Pacific/Fiji',
    ],
    isGlobal: false,
    sortOrder: 6,
  },
  {
    slug: 'south-africa',
    roomId: 'globe:south-africa',
    displayName: 'South Africa',
    description: 'For the Jewish community in South Africa',
    welcomeMessage: 'Welcome to South Africa! This is a space for Jews in South Africa to connect. Be kind, be respectful, and enjoy the conversation.',
    timezones: ['Africa/Johannesburg'],
    isGlobal: false,
    sortOrder: 7,
  },
];

/** Reverse lookup: find the first regional room whose timezones include the given timezone. */
export function getRegionForTimezone(timezone: string): string | null {
  for (const room of GLOBE_ROOMS) {
    if (!room.isGlobal && room.timezones.includes(timezone)) {
      return room.slug;
    }
  }
  return null;
}

/** Check if a slug corresponds to a valid Globe room. */
export function isValidGlobeRoom(slug: string): boolean {
  return GLOBE_ROOMS.some((r) => r.slug === slug);
}

/** Find a Globe room by slug. */
export function getGlobeRoom(slug: string): GlobeRoom | undefined {
  return GLOBE_ROOMS.find((r) => r.slug === slug);
}
