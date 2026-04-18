/**
 * Seed script — populates 24 standard timezone chat rooms with mock messages.
 * Each timezone gets its own exclusive set of 3–4 seed users (no overlap).
 * Run with: npm run db:seed
 *
 * Idempotent: skips rooms that already have messages.
 */

import 'dotenv/config';
import { db, pool } from './index';
import { users, userProfiles, messages } from './schema';
import { sql } from 'drizzle-orm';

// ── Types ────────────────────────────────────────────────────────────────────

type SeedUser = { name: string; handle: string; email: string };
type Line = { userIdx: number; text: string };
type TimezoneData = { tz: string; users: SeedUser[]; messages: Line[] };

// ── Seed data ─────────────────────────────────────────────────────────────────

const TIMEZONE_DATA: TimezoneData[] = [
  {
    tz: 'Pacific/Midway',
    users: [
      { name: 'Jacob Katz',  handle: 'jacob_katz',  email: 'jacob.katz.seed@tribelife.app' },
      { name: 'Maya Levi',   handle: 'maya_levi',   email: 'maya.levi.seed@tribelife.app' },
      { name: 'Sam Stern',   handle: 'sam_stern',   email: 'sam.stern.seed@tribelife.app' },
    ],
    messages: [
      { userIdx: 0, text: "Hey! Anyone else out here at UTC-11? 😄" },
      { userIdx: 1, text: "Ha, yep! Didn't expect to find others here." },
      { userIdx: 2, text: "Same. Really glad someone built an app like this." },
      { userIdx: 0, text: "The timezone community idea is so smart." },
      { userIdx: 1, text: "Right? Makes way more sense than generic social apps." },
      { userIdx: 2, text: "Great to be here with you both." },
      { userIdx: 0, text: "Likewise! Looking forward to seeing this grow." },
      { userIdx: 1, text: "Have either of you tried the beacon feature yet?" },
      { userIdx: 2, text: "Not yet but I'm curious." },
      { userIdx: 0, text: "Me neither — planning to soon." },
      { userIdx: 1, text: "Well, glad we found each other here 🙌" },
    ],
  },
  {
    tz: 'Pacific/Honolulu',
    users: [
      { name: 'Eli Cohen',     handle: 'eli_cohen',    email: 'eli.cohen.seed@tribelife.app' },
      { name: 'Noa Shapiro',   handle: 'noa_shapiro',  email: 'noa.shapiro.seed@tribelife.app' },
      { name: 'Guy Ben-David', handle: 'guy_bd',       email: 'guy.bd.seed@tribelife.app' },
    ],
    messages: [
      { userIdx: 1, text: "Just joined — hello from Hawaii time! 🌺" },
      { userIdx: 0, text: "Hey Noa! Really cool to see this room active." },
      { userIdx: 2, text: "Shalom everyone. Glad someone finally built something like this." },
      { userIdx: 1, text: "Seriously, I've been looking for a community anchored to my timezone." },
      { userIdx: 0, text: "Same feeling. The concept just makes sense." },
      { userIdx: 2, text: "And the beacon matching looks interesting too." },
      { userIdx: 1, text: "Right? Can't wait to try it." },
      { userIdx: 0, text: "Hey, great to be here with you all 👋" },
      { userIdx: 2, text: "This is going to be a nice little community." },
      { userIdx: 1, text: "Agreed. Let's keep it going!" },
      { userIdx: 0, text: "100% 🤙" },
    ],
  },
  {
    tz: 'America/Anchorage',
    users: [
      { name: 'Sagie Mizrahi', handle: 'sagie_m',      email: 'sagie.mizrahi.seed@tribelife.app' },
      { name: 'Tali Peretz',   handle: 'tali_peretz',  email: 'tali.peretz.seed@tribelife.app' },
      { name: 'Ran Goldberg',  handle: 'ran_g',         email: 'ran.goldberg.seed@tribelife.app' },
    ],
    messages: [
      { userIdx: 0, text: "Hey — anyone in the Alaska timezone?" },
      { userIdx: 1, text: "Right here! Wasn't sure I'd find anyone." },
      { userIdx: 2, text: "Same haha. This is actually exciting." },
      { userIdx: 0, text: "I love the idea of a community organized by timezone." },
      { userIdx: 1, text: "It removes so much friction. Everyone's awake at the same time." },
      { userIdx: 2, text: "Exactly! Finally makes sense to message people." },
      { userIdx: 0, text: "Great to be here with you both." },
      { userIdx: 1, text: "Glad someone built this app, seriously." },
      { userIdx: 2, text: "Ditto. Looking forward to seeing it grow." },
      { userIdx: 0, text: "Let's make this room a good one 🚀" },
    ],
  },
  {
    tz: 'America/Los_Angeles',
    users: [
      { name: 'Amir Friedman', handle: 'amir_f',       email: 'amir.friedman.seed@tribelife.app' },
      { name: 'Shira Blum',    handle: 'shira_blum',   email: 'shira.blum.seed@tribelife.app' },
      { name: 'Noam Bar',      handle: 'noam_bar',     email: 'noam.bar.seed@tribelife.app' },
      { name: 'Leah Gold',     handle: 'leah_gold',    email: 'leah.gold.seed@tribelife.app' },
    ],
    messages: [
      { userIdx: 1, text: "Hello West Coast! Just found this app and I'm already obsessed." },
      { userIdx: 0, text: "Hey Shira! Same. The timezone community model is something I've wanted for years." },
      { userIdx: 2, text: "Glad I'm not the only one who felt that way." },
      { userIdx: 3, text: "Just joined too — great to be here everyone." },
      { userIdx: 1, text: "Welcome Leah! This room is growing 😊" },
      { userIdx: 0, text: "I tried posting in other community apps and half the replies came at 3am my time." },
      { userIdx: 2, text: "Haha yes, the timezone mismatch problem is real." },
      { userIdx: 3, text: "This solves it perfectly. Really clever design." },
      { userIdx: 1, text: "And the matching feature — anyone tried it?" },
      { userIdx: 0, text: "Not yet but it sounds fascinating." },
      { userIdx: 2, text: "I set up a beacon yesterday. Will report back." },
      { userIdx: 3, text: "Excited to hear how it goes!" },
      { userIdx: 1, text: "This community already feels different. Happy to be here 🙌" },
    ],
  },
  {
    tz: 'America/Denver',
    users: [
      { name: 'Yael Horowitz', handle: 'yael_h',      email: 'yael.horowitz.seed@tribelife.app' },
      { name: 'Ben Schwartz',  handle: 'ben_schwartz', email: 'ben.schwartz.seed@tribelife.app' },
      { name: 'Lihi Oren',     handle: 'lihi_oren',   email: 'lihi.oren.seed@tribelife.app' },
    ],
    messages: [
      { userIdx: 1, text: "Mountain Time crew, where are you at? 🏔" },
      { userIdx: 0, text: "Right here! Yael from Denver." },
      { userIdx: 2, text: "Hey! Lihi here, this is such a cool concept." },
      { userIdx: 1, text: "Right? The moment I read about timezone rooms I knew I had to join." },
      { userIdx: 0, text: "Exactly. So tired of communities where no one is ever online at the same time as me." },
      { userIdx: 2, text: "Ha, the story of my digital life until now." },
      { userIdx: 1, text: "Glad someone finally built something like this." },
      { userIdx: 0, text: "Same. This is the community model that should have existed ages ago." },
      { userIdx: 2, text: "Great to be here with you both 🙂" },
      { userIdx: 1, text: "Feeling good about this one." },
      { userIdx: 0, text: "Let's keep this going! 🚀" },
    ],
  },
  {
    tz: 'America/Chicago',
    users: [
      { name: 'Avi Rosenberg', handle: 'avi_r',       email: 'avi.rosenberg.seed@tribelife.app' },
      { name: 'Dana Weiss',    handle: 'dana_weiss',  email: 'dana.weiss.seed@tribelife.app' },
      { name: 'Itai Feldman',  handle: 'itai_f',      email: 'itai.feldman.seed@tribelife.app' },
    ],
    messages: [
      { userIdx: 2, text: "Hey Central Time people! Anyone home?" },
      { userIdx: 0, text: "Yep! Just discovered this app today." },
      { userIdx: 1, text: "Same here — and I'm already a fan." },
      { userIdx: 2, text: "The timezone room is such a good idea." },
      { userIdx: 0, text: "I've said for years that timezone is the real community filter, not location." },
      { userIdx: 1, text: "Agreed. Much more relevant than just saying you're from 'the Midwest.'" },
      { userIdx: 2, text: "Haha true. This feels more natural." },
      { userIdx: 0, text: "Great to be here with you both." },
      { userIdx: 1, text: "Glad someone built this." },
      { userIdx: 2, text: "Same. Let's make this room great 💪" },
      { userIdx: 0, text: "Let's do it." },
    ],
  },
  {
    tz: 'America/New_York',
    users: [
      { name: 'Ron Greenberg', handle: 'ron_g',        email: 'ron.greenberg.seed@tribelife.app' },
      { name: 'Michal Levy',   handle: 'michal_levy',  email: 'michal.levy.seed@tribelife.app' },
      { name: 'Dov Stern',     handle: 'dov_stern',    email: 'dov.stern.seed@tribelife.app' },
      { name: 'Sari Bloch',    handle: 'sari_bloch',   email: 'sari.bloch.seed@tribelife.app' },
    ],
    messages: [
      { userIdx: 0, text: "ET room checking in 👋 Who else is here?" },
      { userIdx: 1, text: "Hey! Just joined. Love the concept of this app." },
      { userIdx: 2, text: "Same, found it yesterday and immediately signed up." },
      { userIdx: 3, text: "Hello everyone! Great to be here." },
      { userIdx: 0, text: "This is already more active than I expected for a new app." },
      { userIdx: 1, text: "The timezone-first design is so refreshing." },
      { userIdx: 2, text: "Totally. I can actually see myself using this daily." },
      { userIdx: 3, text: "Has anyone tried the beacon matching yet?" },
      { userIdx: 0, text: "I did! Got matched with someone who has similar interests. Really neat." },
      { userIdx: 1, text: "Oh wow, that was fast. Impressed." },
      { userIdx: 2, text: "Glad someone built something like this. Seriously." },
      { userIdx: 3, text: "Echo that. This community already feels real." },
      { userIdx: 0, text: "Happy to be here with you all 🙌" },
    ],
  },
  {
    tz: 'America/Halifax',
    users: [
      { name: 'Gal Barak',  handle: 'gal_barak',  email: 'gal.barak.seed@tribelife.app' },
      { name: 'Inbar Cohen', handle: 'inbar_c',   email: 'inbar.cohen.seed@tribelife.app' },
      { name: 'Yoav Nir',   handle: 'yoav_nir',  email: 'yoav.nir.seed@tribelife.app' },
    ],
    messages: [
      { userIdx: 1, text: "Anyone in the Atlantic timezone? 🌊" },
      { userIdx: 0, text: "Right here! This room is quieter than I expected but glad it exists." },
      { userIdx: 2, text: "Ha same. Was starting to feel like the only one in this timezone." },
      { userIdx: 1, text: "Well not anymore! Really happy to find this app." },
      { userIdx: 0, text: "The timezone room concept is brilliant honestly." },
      { userIdx: 2, text: "Agreed. It's the first app that made me feel like the community is actually local." },
      { userIdx: 1, text: "Exactly what I was looking for." },
      { userIdx: 0, text: "Great to be here with you both 😊" },
      { userIdx: 2, text: "Same! Let's keep this room alive." },
      { userIdx: 1, text: "Definitely. Glad someone built something like this." },
    ],
  },
  {
    tz: 'America/Sao_Paulo',
    users: [
      { name: 'Tamar Silverman', handle: 'tamar_s',   email: 'tamar.silverman.seed@tribelife.app' },
      { name: 'Eran Dayan',      handle: 'eran_d',    email: 'eran.dayan.seed@tribelife.app' },
      { name: 'Roni Ashkenazi',  handle: 'roni_ash',  email: 'roni.ashkenazi.seed@tribelife.app' },
    ],
    messages: [
      { userIdx: 0, text: "Oi gente! Anyone here from Brazil time zone?" },
      { userIdx: 1, text: "Hey! Eran here. Great to see this room exist." },
      { userIdx: 2, text: "Same! Just discovered TribeLife. Love the concept." },
      { userIdx: 0, text: "It makes so much sense to organize by timezone." },
      { userIdx: 1, text: "Especially for those of us who are far from the major hubs." },
      { userIdx: 2, text: "Exactly. Tired of communities that are always asleep when I'm online." },
      { userIdx: 0, text: "Haha yes! This solves that perfectly." },
      { userIdx: 1, text: "Glad someone built something like this." },
      { userIdx: 2, text: "Great to be here with you both 🙌" },
      { userIdx: 0, text: "Let's make this a great room." },
      { userIdx: 1, text: "Definitely. Looking forward to it!" },
    ],
  },
  {
    tz: 'Atlantic/South_Georgia',
    users: [
      { name: 'Ohad Tzur',   handle: 'ohad_tzur',  email: 'ohad.tzur.seed@tribelife.app' },
      { name: 'Sari Ben-Ami', handle: 'sari_ba',   email: 'sari.benami.seed@tribelife.app' },
      { name: 'Lior Hazan',  handle: 'lior_hazan', email: 'lior.hazan.seed@tribelife.app' },
    ],
    messages: [
      { userIdx: 2, text: "UTC-2 timezone — anyone here? 👋" },
      { userIdx: 0, text: "Hey Lior! Yeah, I'm here. Surprised this room exists honestly." },
      { userIdx: 1, text: "Same. Glad it does though." },
      { userIdx: 2, text: "TribeLife is such a cool concept. Timezone-first community." },
      { userIdx: 0, text: "That's the part that got me. Makes every interaction feel more relevant." },
      { userIdx: 1, text: "Totally. People are actually awake and in the same headspace." },
      { userIdx: 2, text: "Great to be here with you both 😊" },
      { userIdx: 0, text: "Likewise! Glad someone built this." },
      { userIdx: 1, text: "Let's keep this going 🚀" },
      { userIdx: 2, text: "100%!" },
    ],
  },
  {
    tz: 'Atlantic/Azores',
    users: [
      { name: 'Hila Paz',   handle: 'hila_paz',   email: 'hila.paz.seed@tribelife.app' },
      { name: 'Ariel Kohn', handle: 'ariel_kohn', email: 'ariel.kohn.seed@tribelife.app' },
      { name: 'Ofri Segal', handle: 'ofri_segal', email: 'ofri.segal.seed@tribelife.app' },
    ],
    messages: [
      { userIdx: 1, text: "Hello Azores/UTC-1 timezone! Anyone around?" },
      { userIdx: 0, text: "Right here! Wasn't expecting a timezone room this specific." },
      { userIdx: 2, text: "Ha! Same thought. Love that it exists." },
      { userIdx: 1, text: "TribeLife is really onto something with this model." },
      { userIdx: 0, text: "Agreed. The timezone community angle is genuinely fresh." },
      { userIdx: 2, text: "I've tried so many community apps. This one actually makes sense." },
      { userIdx: 1, text: "Glad to hear it. Great to be here with you both." },
      { userIdx: 0, text: "Same! Looking forward to seeing more people join." },
      { userIdx: 2, text: "Glad someone finally built something like this 🙌" },
      { userIdx: 1, text: "Let's make it great." },
    ],
  },
  {
    tz: 'Europe/London',
    users: [
      { name: 'Naomi Gold',  handle: 'naomi_gold',  email: 'naomi.gold.seed@tribelife.app' },
      { name: 'Tal Brenner', handle: 'tal_brenner', email: 'tal.brenner.seed@tribelife.app' },
      { name: 'Dan Adler',   handle: 'dan_adler',   email: 'dan.adler.seed@tribelife.app' },
      { name: 'Bat-El Carmi', handle: 'batel_c',    email: 'batel.carmi.seed@tribelife.app' },
    ],
    messages: [
      { userIdx: 0, text: "London timezone room! Hello everyone 👋" },
      { userIdx: 2, text: "Hey! Dan here. Just joined, love the idea of this app." },
      { userIdx: 1, text: "Same! Was looking for exactly this kind of community." },
      { userIdx: 3, text: "Hi all! Great to be here." },
      { userIdx: 0, text: "This room is actually active — I'm surprised and delighted." },
      { userIdx: 2, text: "The timezone community model is so clever." },
      { userIdx: 1, text: "Right? It removes so much friction. We're all roughly awake at the same time." },
      { userIdx: 3, text: "And you can actually have real-time conversations." },
      { userIdx: 0, text: "Has anyone tried the beacon matching? I'm curious." },
      { userIdx: 2, text: "Not yet but it sounds really interesting." },
      { userIdx: 1, text: "I matched with someone yesterday! The intent matching is impressive." },
      { userIdx: 3, text: "Oh wow, that was quick. This app is the real deal." },
      { userIdx: 0, text: "Glad someone built something like this. Happy to be here 🙌" },
    ],
  },
  {
    tz: 'Europe/Paris',
    users: [
      { name: 'Avital Ran',    handle: 'avital_ran',   email: 'avital.ran.seed@tribelife.app' },
      { name: 'Gali Mor',      handle: 'gali_mor',     email: 'gali.mor.seed@tribelife.app' },
      { name: 'Yonatan Edri',  handle: 'yonatan_e',    email: 'yonatan.edri.seed@tribelife.app' },
    ],
    messages: [
      { userIdx: 2, text: "CET timezone, anyone here? Bonjour 😄" },
      { userIdx: 0, text: "Hey Yonatan! Avital here. Glad I found this app." },
      { userIdx: 1, text: "Same! Gali here. The concept is brilliant." },
      { userIdx: 2, text: "Right? A community organized by timezone instead of country. Finally." },
      { userIdx: 0, text: "I've been waiting for something like this." },
      { userIdx: 1, text: "Ditto. Most communities feel scattered time-wise. This fixes that." },
      { userIdx: 2, text: "And everyone here is roughly in the same part of the day." },
      { userIdx: 0, text: "Makes conversations feel so much more alive." },
      { userIdx: 1, text: "Great to be here with you both 🙂" },
      { userIdx: 2, text: "Glad someone built something like this. Let's make it great!" },
      { userIdx: 0, text: "Agreed. Looking forward to it 🚀" },
    ],
  },
  {
    tz: 'Asia/Jerusalem',
    users: [
      { name: 'Ayelet Saar',  handle: 'ayelet_s',   email: 'ayelet.saar.seed@tribelife.app' },
      { name: 'Nir Lapid',    handle: 'nir_lapid',  email: 'nir.lapid.seed@tribelife.app' },
      { name: 'Shir Cohen',   handle: 'shir_cohen', email: 'shir.cohen.seed@tribelife.app' },
      { name: 'Omer Kedar',   handle: 'omer_kedar', email: 'omer.kedar.seed@tribelife.app' },
    ],
    messages: [
      { userIdx: 1, text: "Shalom! Anyone in the Israel timezone?" },
      { userIdx: 0, text: "Hey Nir! Ayelet here. So excited about this app." },
      { userIdx: 2, text: "Same! Shir here. The whole timezone community concept is really smart." },
      { userIdx: 3, text: "Hi all! Just joined. Great to see the room active." },
      { userIdx: 1, text: "Welcome Omer! This is growing fast." },
      { userIdx: 0, text: "I love that this isn't trying to be global. It's intentionally local-in-time." },
      { userIdx: 2, text: "Exactly. It finally makes sense why you'd talk to specific people." },
      { userIdx: 3, text: "And the beacon matching on top of that is a nice layer." },
      { userIdx: 1, text: "Right? Connecting people with similar intentions, same timezone — great combo." },
      { userIdx: 0, text: "Glad someone built something like this." },
      { userIdx: 2, text: "Really happy to be here with you all 🙌" },
      { userIdx: 3, text: "Same. Let's keep this going!" },
    ],
  },
  {
    tz: 'Europe/Moscow',
    users: [
      { name: 'Boaz Tzvi',   handle: 'boaz_tzvi',  email: 'boaz.tzvi.seed@tribelife.app' },
      { name: 'Efrat Haim',  handle: 'efrat_haim', email: 'efrat.haim.seed@tribelife.app' },
      { name: 'Omri Katz',   handle: 'omri_katz',  email: 'omri.katz.seed@tribelife.app' },
    ],
    messages: [
      { userIdx: 0, text: "UTC+3 timezone checking in! Anyone here?" },
      { userIdx: 2, text: "Hey Boaz! Omri here. Happy to find this room." },
      { userIdx: 1, text: "Hey guys! Efrat here. Just joined TribeLife today." },
      { userIdx: 0, text: "Welcome! What do you think so far?" },
      { userIdx: 1, text: "Honestly, the timezone community model is what got me. So original." },
      { userIdx: 2, text: "Same. I've tried so many community apps. This one has a real angle." },
      { userIdx: 0, text: "Totally. It feels grounded. Like you're talking to people who are actually in your world." },
      { userIdx: 1, text: "Exactly. Great to be here with you both." },
      { userIdx: 2, text: "Glad someone built something like this 🙌" },
      { userIdx: 0, text: "Let's make this room a good one 🚀" },
    ],
  },
  {
    tz: 'Asia/Dubai',
    users: [
      { name: 'Doron Levy',    handle: 'doron_levy',  email: 'doron.levy.seed@tribelife.app' },
      { name: 'Neta Bar',      handle: 'neta_bar',    email: 'neta.bar.seed@tribelife.app' },
      { name: 'Shlomi Edelman', handle: 'shlomi_e',  email: 'shlomi.edelman.seed@tribelife.app' },
    ],
    messages: [
      { userIdx: 1, text: "Hey everyone! Anyone in the Gulf timezone?" },
      { userIdx: 0, text: "Right here! Doron, based in Dubai. Love this app." },
      { userIdx: 2, text: "Hey! Shlomi here. Just found TribeLife and I'm impressed." },
      { userIdx: 1, text: "Same! The timezone community concept is so smart." },
      { userIdx: 0, text: "Finally a community that makes geographic-ish sense." },
      { userIdx: 2, text: "And without being tied to a specific city. Timezone is the right granularity." },
      { userIdx: 1, text: "Perfectly said. Great to be here with you both." },
      { userIdx: 0, text: "Really happy to find this room." },
      { userIdx: 2, text: "Glad someone built something like this 🙌" },
      { userIdx: 1, text: "Same. Looking forward to connecting more here!" },
    ],
  },
  {
    tz: 'Asia/Karachi',
    users: [
      { name: 'Ilan Tzur',   handle: 'ilan_tzur',  email: 'ilan.tzur.seed@tribelife.app' },
      { name: 'Pnina Cohen', handle: 'pnina_c',    email: 'pnina.cohen.seed@tribelife.app' },
      { name: 'Roi Shapiro', handle: 'roi_s',      email: 'roi.shapiro.seed@tribelife.app' },
    ],
    messages: [
      { userIdx: 2, text: "UTC+5 room, anyone here? 👋" },
      { userIdx: 0, text: "Hey! Ilan here. Glad this room exists." },
      { userIdx: 1, text: "Same! Pnina here. Just discovered TribeLife." },
      { userIdx: 2, text: "What do you think so far?" },
      { userIdx: 0, text: "Love it. The timezone-based community model is fresh and practical." },
      { userIdx: 1, text: "Agreed. Feels like the communities I always wanted but never found." },
      { userIdx: 2, text: "Right? Glad someone finally built something like this." },
      { userIdx: 0, text: "Great to be here with you both 😊" },
      { userIdx: 1, text: "Same. Let's keep this room alive!" },
      { userIdx: 2, text: "Definitely. Looking forward to it 🚀" },
    ],
  },
  {
    tz: 'Asia/Kolkata',
    users: [
      { name: 'Yarden Blau',  handle: 'yarden_b',     email: 'yarden.blau.seed@tribelife.app' },
      { name: 'Sigal Nir',    handle: 'sigal_nir',    email: 'sigal.nir.seed@tribelife.app' },
      { name: 'Tal Peretz',   handle: 'tal_peretz',   email: 'tal.peretz.seed@tribelife.app' },
    ],
    messages: [
      { userIdx: 0, text: "IST timezone — hello! Anyone around?" },
      { userIdx: 2, text: "Hey Yarden! Tal here. Yes! Glad to see this room." },
      { userIdx: 1, text: "Sigal here! Just joined TribeLife. This concept is amazing." },
      { userIdx: 0, text: "Right? Organizing communities by timezone instead of country is genius." },
      { userIdx: 2, text: "It removes so much of the noise. Conversations feel more timely." },
      { userIdx: 1, text: "Exactly! People are actually online when I am." },
      { userIdx: 0, text: "Ha, finally!" },
      { userIdx: 2, text: "Great to be here with you both." },
      { userIdx: 1, text: "Glad someone built something like this 🙌" },
      { userIdx: 0, text: "Let's make this room a great one." },
      { userIdx: 2, text: "Agreed. Looking forward to it!" },
    ],
  },
  {
    tz: 'Asia/Bangkok',
    users: [
      { name: 'Omer Ben-David',  handle: 'omer_bd',      email: 'omer.bendavid.seed@tribelife.app' },
      { name: 'Hadar Katz',      handle: 'hadar_katz',   email: 'hadar.katz.seed@tribelife.app' },
      { name: 'Ziv Greenberg',   handle: 'ziv_g',        email: 'ziv.greenberg.seed@tribelife.app' },
    ],
    messages: [
      { userIdx: 1, text: "ICT timezone! Anyone here? 🌏" },
      { userIdx: 0, text: "Hey Hadar! Omer here. This room is a great idea." },
      { userIdx: 2, text: "Ziv here! Just joined. I really like what this app is doing." },
      { userIdx: 1, text: "The timezone community concept is so smart." },
      { userIdx: 0, text: "It's the first time I feel like a community actually fits my schedule." },
      { userIdx: 2, text: "Totally. Glad someone finally built something like this." },
      { userIdx: 1, text: "Great to be here with you both 😊" },
      { userIdx: 0, text: "Same! Looking forward to seeing this grow." },
      { userIdx: 2, text: "Let's make this room great 🚀" },
      { userIdx: 1, text: "100%!" },
    ],
  },
  {
    tz: 'Asia/Singapore',
    users: [
      { name: 'Amit Goldstein', handle: 'amit_gs',     email: 'amit.goldstein.seed@tribelife.app' },
      { name: 'Keren Levy',     handle: 'keren_levy',  email: 'keren.levy.seed@tribelife.app' },
      { name: 'Yuval Cohen',    handle: 'yuval_c',     email: 'yuval.cohen.seed@tribelife.app' },
      { name: 'Nili Barak',     handle: 'nili_barak',  email: 'nili.barak.seed@tribelife.app' },
    ],
    messages: [
      { userIdx: 0, text: "SGT timezone crew, hello! 🇸🇬" },
      { userIdx: 1, text: "Hey! Keren here. So excited about TribeLife." },
      { userIdx: 2, text: "Same! Yuval here. The concept is exactly what I was looking for." },
      { userIdx: 3, text: "Nili here! Just joined. Great to see the room active already." },
      { userIdx: 0, text: "Welcome! This is growing nicely." },
      { userIdx: 1, text: "I love the timezone-first model. It makes communities feel real." },
      { userIdx: 2, text: "Right? You actually know people are around when you post." },
      { userIdx: 3, text: "That's what always bothered me about other apps. The asynchronous chaos." },
      { userIdx: 0, text: "Ha, well said. This is a much better model." },
      { userIdx: 1, text: "Glad someone built something like this 🙌" },
      { userIdx: 2, text: "Great to be here with everyone." },
      { userIdx: 3, text: "Agreed! Let's keep this going 🚀" },
    ],
  },
  {
    tz: 'Asia/Tokyo',
    users: [
      { name: 'Shimon Raz',  handle: 'shimon_raz',  email: 'shimon.raz.seed@tribelife.app' },
      { name: 'Gila Stern',  handle: 'gila_stern',  email: 'gila.stern.seed@tribelife.app' },
      { name: 'Nadav Bar',   handle: 'nadav_bar',   email: 'nadav.bar.seed@tribelife.app' },
    ],
    messages: [
      { userIdx: 2, text: "JST timezone! Hey everyone 👋" },
      { userIdx: 0, text: "Hey Nadav! Shimon here. Happy to see this room." },
      { userIdx: 1, text: "Gila here! Just joined. This app has such a unique angle." },
      { userIdx: 2, text: "Right? Timezone as community backbone — never seen it done this way." },
      { userIdx: 0, text: "It's so practical. I'm always awake with people 12 hours off from me on other apps." },
      { userIdx: 1, text: "Haha yes, the 3am reply problem. This solves it." },
      { userIdx: 2, text: "Exactly. Glad someone finally built something like this." },
      { userIdx: 0, text: "Great to be here with you both 😊" },
      { userIdx: 1, text: "Same! This community already feels good." },
      { userIdx: 2, text: "Let's make it great 🚀" },
      { userIdx: 0, text: "Let's do it!" },
    ],
  },
  {
    tz: 'Australia/Sydney',
    users: [
      { name: 'Ora Friedman', handle: 'ora_f',      email: 'ora.friedman.seed@tribelife.app' },
      { name: 'Yair Mizrahi', handle: 'yair_m',     email: 'yair.mizrahi.seed@tribelife.app' },
      { name: 'Tamar Blum',   handle: 'tamar_blum', email: 'tamar.blum.seed@tribelife.app' },
    ],
    messages: [
      { userIdx: 1, text: "AEST crew! Anyone here? G'day 😄" },
      { userIdx: 0, text: "Hey Yair! Ora here. Really loving TribeLife so far." },
      { userIdx: 2, text: "Tamar here! Just discovered this app. The timezone room is such a good idea." },
      { userIdx: 1, text: "Right? We're always the ones awake when everyone else is asleep." },
      { userIdx: 0, text: "Ha, the Australian timezone problem is very real." },
      { userIdx: 2, text: "This app actually solves it. A community that's awake when we are." },
      { userIdx: 1, text: "Exactly. Glad someone finally thought of this." },
      { userIdx: 0, text: "Great to be here with you both 🙌" },
      { userIdx: 2, text: "Same! Looking forward to seeing this grow." },
      { userIdx: 1, text: "Let's make it a good room. Go team Australia! 🦘" },
      { userIdx: 0, text: "Haha love it 😄" },
    ],
  },
  {
    tz: 'Pacific/Guadalcanal',
    users: [
      { name: 'Natan Segal',  handle: 'natan_s',    email: 'natan.segal.seed@tribelife.app' },
      { name: 'Rivka Adler',  handle: 'rivka_a',    email: 'rivka.adler.seed@tribelife.app' },
      { name: 'Gil Barak',    handle: 'gil_barak',  email: 'gil.barak.seed@tribelife.app' },
    ],
    messages: [
      { userIdx: 0, text: "UTC+11 room! Hello? Anyone out here? 😄" },
      { userIdx: 2, text: "Hey Natan! Gil here. Was wondering if anyone would show up." },
      { userIdx: 1, text: "Rivka here! Ha, same thought. Love that this room exists." },
      { userIdx: 0, text: "TribeLife is really onto something with the timezone model." },
      { userIdx: 2, text: "100%. It's such a natural way to group people." },
      { userIdx: 1, text: "And everyone here is actually awake at the same time. Imagine that." },
      { userIdx: 0, text: "Revolutionary concept, somehow 😄" },
      { userIdx: 2, text: "Glad someone built something like this." },
      { userIdx: 1, text: "Great to be here with you both 🙌" },
      { userIdx: 0, text: "Same. Let's keep this going!" },
    ],
  },
  {
    tz: 'Pacific/Auckland',
    users: [
      { name: 'Dina Rotem',  handle: 'dina_rotem',  email: 'dina.rotem.seed@tribelife.app' },
      { name: 'Asaf Cohen',  handle: 'asaf_cohen',  email: 'asaf.cohen.seed@tribelife.app' },
      { name: 'Yael Carmi',  handle: 'yael_carmi',  email: 'yael.carmi.seed@tribelife.app' },
    ],
    messages: [
      { userIdx: 1, text: "NZST checking in! Hello from the future 😄" },
      { userIdx: 0, text: "Haha hey Asaf! Dina here. Love it." },
      { userIdx: 2, text: "Yael here! Was excited to see if this room had anyone. It does!" },
      { userIdx: 1, text: "I love this app's concept. Timezone-based community is so smart." },
      { userIdx: 0, text: "Finally a community where people are actually online when I am." },
      { userIdx: 2, text: "Right? No more 14-hour reply delays." },
      { userIdx: 1, text: "Haha exactly. Glad someone built something like this." },
      { userIdx: 0, text: "Great to be here with you both 🙌" },
      { userIdx: 2, text: "Same! This community already feels right." },
      { userIdx: 1, text: "Let's make it great. Kia ora! 🇳🇿" },
      { userIdx: 0, text: "Love it 😄" },
    ],
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * 60 * 1000);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🌱  Seeding timezone chat rooms…\n');

  let totalMessages = 0;
  let skipped = 0;

  for (const tzData of TIMEZONE_DATA) {
    const roomId = `timezone:${tzData.tz}`;

    // Skip if room already has messages
    const existing = await db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM messages WHERE room_id = ${roomId}`
    );
    if (parseInt(existing.rows[0].count) > 0) {
      console.log(`  ⏭  ${tzData.tz} — already seeded, skipping`);
      skipped++;
      continue;
    }

    // Upsert users
    const userIds: number[] = [];
    for (const u of tzData.users) {
      // Insert user, get id back (handle conflict gracefully)
      await db.execute(
        sql`INSERT INTO users (name, email) VALUES (${u.name}, ${u.email}) ON CONFLICT (email) DO NOTHING`
      );
      const row = await db.execute<{ id: number }>(
        sql`SELECT id FROM users WHERE email = ${u.email}`
      );
      const userId = row.rows[0].id;
      userIds.push(userId);

      // Upsert profile
      await db.execute(
        sql`INSERT INTO user_profiles (user_id, handle, timezone)
            VALUES (${userId}, ${u.handle}, ${tzData.tz})
            ON CONFLICT (user_id) DO NOTHING`
      );
    }

    // Insert messages with staggered timestamps (2-4 days ago, ~10 min apart)
    const baseMinutesAgo = 2 * 24 * 60 + (tzData.tz.length * 17 % (48 * 60));
    for (let i = 0; i < tzData.messages.length; i++) {
      const line = tzData.messages[i];
      const senderId = userIds[line.userIdx];
      const createdAt = minutesAgo(baseMinutesAgo - i * 10);
      await db.execute(
        sql`INSERT INTO messages (content, sender_id, room_id, created_at)
            VALUES (${line.text}, ${senderId}, ${roomId}, ${createdAt})`
      );
    }

    totalMessages += tzData.messages.length;
    console.log(`  ✓ ${tzData.tz} — ${tzData.messages.length} messages, ${tzData.users.length} users`);
  }

  console.log(`\n🎉  Done! Seeded ${totalMessages} messages across ${TIMEZONE_DATA.length - skipped} rooms (${skipped} skipped).`);

  // ── news_config seeds (idempotent) ─────────────────────────────────────────
  // Phase 4 D-08: push_max_age_minutes controls the freshness window used by
  // the breaking-news push dispatch sweep (skip push if publishedAt > N min old).
  // Baseline Phase 1 D-09 + Phase 2 ENRICH-06/07 defaults live in the drizzle
  // migrations (0006_secret_blade.sql, 0007_enrichment_seeds.sql); this INSERT
  // mirrors that style so operators who re-run `npm run db:seed` get the full
  // config set even on environments where the migrations were skipped.
  await db.execute(sql`
    INSERT INTO news_config (key, value, updated_at)
    VALUES ('push_max_age_minutes', '60'::jsonb, NOW())
    ON CONFLICT (key) DO NOTHING
  `);
  console.log('  ✓ news_config push_max_age_minutes=60 (idempotent)');

  await pool.end();
}

main().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
