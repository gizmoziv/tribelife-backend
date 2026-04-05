/**
 * Promo seed script — generates 700+ realistic mock users with beacons,
 * conversations, and messages for screenshots and promotional videos.
 *
 * Run with: npm run db:seed:promo
 *
 * Features:
 * - 700+ users across all globe regions
 * - Israeli names for Asia/Jerusalem timezone
 * - European Jewish names for European timezones
 * - Modern American/Canadian Jewish names for North America
 * - Latin American, Australian, South African Jewish names
 * - Natural handle formatting (not all underscores)
 * - Beacons per user (studying, guitar, business, etc.)
 * - Miami-specific beacons: investment, pickleball, coffee
 * - @rose user in Miami (premium, 3 beacons)
 * - Conversations ranging from "hey I'm new" to "Happy Passover!"
 * - Globe room and timezone room messages
 */

import 'dotenv/config';
import { db, pool } from './index';
import { sql } from 'drizzle-orm';

// ── Types ────────────────────────────────────────────────────────────────────

interface MockUser {
  name: string;
  handle: string;
  email: string;
  timezone: string;
  isPremium: boolean;
}

// ── Name pools by region ─────────────────────────────────────────────────────

const ISRAELI_FIRST = [
  'Noam', 'Ori', 'Lior', 'Shira', 'Noa', 'Yonatan', 'Tamar', 'Idan', 'Maya',
  'Omer', 'Rotem', 'Gal', 'Amit', 'Yael', 'Tal', 'Eyal', 'Lihi', 'Nitzan',
  'Shachar', 'Inbar', 'Itai', 'Keren', 'Alon', 'Hadar', 'Dor', 'Noga', 'Gilad',
  'Sapir', 'Tomer', 'Mika', 'Raz', 'Yuval', 'Maayan', 'Ofir', 'Shai', 'Stav',
  'Eden', 'Avital', 'Ariel', 'Dana', 'Nadav', 'Roni', 'Neta', 'Shirel', 'Bar',
  'Moran', 'Lavi', 'Tzuf', 'Agam', 'Anat', 'Doron', 'Ella', 'Gili', 'Hila',
  'Irit', 'Kobi', 'Liora', 'Merav', 'Naama', 'Osnat', 'Paz', 'Ravit', 'Sarit',
  'Tehila', 'Uri', 'Vered', 'Yarden', 'Zohar', 'Eliana', 'Dvir', 'Chen', 'Barak',
  'Efrat', 'Gaia', 'Hallel', 'Karni', 'Liat', 'Miri', 'Nimrod', 'Oren', 'Shaked',
];

const ISRAELI_LAST = [
  'Cohen', 'Levi', 'Mizrahi', 'Peretz', 'Biton', 'Dahan', 'Avraham', 'Friedman',
  'Katz', 'Shapiro', 'Goldberg', 'Rosenberg', 'Stern', 'Weiss', 'Klein', 'Fischer',
  'Ben-David', 'Ben-Ari', 'Ben-Haim', 'Azulay', 'Ochana', 'Gabay', 'Hadad', 'Amar',
  'Malka', 'Ohana', 'Levy', 'Shalev', 'Zohar', 'Tzur', 'Shemesh', 'Barak', 'Almog',
  'Raz', 'Yosef', 'David', 'Asher', 'Sagiv', 'Nir', 'Oren', 'Navon', 'Koren',
  'Dayan', 'Shaul', 'Golan', 'Carmel', 'Rosen', 'Peled', 'Tal', 'Regev', 'Harel',
];

const EURO_FIRST = [
  'Daniel', 'Miriam', 'David', 'Sarah', 'Jonathan', 'Rebecca', 'Benjamin', 'Hannah',
  'Samuel', 'Esther', 'Raphael', 'Leah', 'Gabriel', 'Rachel', 'Adam', 'Naomi',
  'Nathan', 'Deborah', 'Joshua', 'Ruth', 'Simon', 'Eva', 'Max', 'Anna', 'Leo',
  'Sophie', 'Felix', 'Clara', 'Julian', 'Lena', 'Theo', 'Mila', 'Noah', 'Emma',
  'Elias', 'Lina', 'Oscar', 'Nora', 'Marcus', 'Alma', 'Laurent', 'Juliette',
  'Pierre', 'Amelie', 'Antoine', 'Celine', 'Matteo', 'Giulia', 'Alessandro', 'Elena',
  'Hugo', 'Camille', 'Arthur', 'Louise', 'Axel', 'Astrid', 'Erik', 'Ingrid',
  'Klaus', 'Hanna', 'Lukas', 'Marie', 'Thomas', 'Charlotte', 'Stefan', 'Lotte',
  'Jan', 'Annika', 'Filip', 'Maja', 'Jakub', 'Zuzana', 'Andrei', 'Irina',
];

const EURO_LAST = [
  'Goldstein', 'Rosenthal', 'Blumenthal', 'Strauss', 'Adler', 'Berger', 'Braun',
  'Fleischer', 'Frankel', 'Heller', 'Jacobson', 'Kohn', 'Landau',
  'Meyer', 'Neumann', 'Oppenheim', 'Pollak', 'Rosenfeld', 'Schapiro', 'Weil',
  'Zimmerman', 'Bauer', 'Stein', 'Singer', 'Rothschild', 'Lichtenstein', 'Baum',
  'Eisenberg', 'Feldman', 'Geller', 'Hirsch', 'Kaufman', 'Lehmann', 'Mendel',
  'Nordhaus', 'Perl', 'Reis', 'Salomon', 'Tauber', 'Vogel', 'Werner', 'Altman',
  'Bloch', 'Dreyfus', 'Ehrlich', 'Gutmann', 'Hertz', 'Isaacs', 'Kessler',
];

const UK_FIRST = [
  'James', 'Oliver', 'Charlotte', 'Amelia', 'Benjamin', 'Isabella', 'Henry',
  'Sophie', 'William', 'Emily', 'Harry', 'Grace', 'Jack', 'Lily', 'George',
  'Ella', 'Edward', 'Ruby', 'Oscar', 'Mia', 'Leo', 'Phoebe', 'Toby', 'Jessica',
  'Sam', 'Chloe', 'Alex', 'Hannah', 'Tom', 'Zara', 'Daniel', 'Eve', 'Jake',
  'Molly', 'Freddie', 'Ava', 'Archie', 'Ivy', 'Charlie', 'Daisy',
];

const UK_LAST = [
  'Levy', 'Goldberg', 'Marks', 'Simons', 'Harris', 'Grant', 'Phillips', 'Davis',
  'Hart', 'Shaw', 'Green', 'Morris', 'Rose', 'Fox', 'Stone', 'Silver', 'Pearl',
  'Bloom', 'Glass', 'Baron', 'Samuels', 'Joseph', 'Solomon', 'Benjamin', 'Hyams',
  'Jacobs', 'Abrahams', 'Angel', 'Castle', 'Moss', 'Isaacs', 'Nathan', 'Segal',
];

const NA_FIRST = [
  'Ethan', 'Ava', 'Liam', 'Sophia', 'Jacob', 'Olivia', 'Noah', 'Emma', 'Mason',
  'Isabella', 'Caleb', 'Chloe', 'Asher', 'Zoe', 'Ezra', 'Lily', 'Micah', 'Maya',
  'Jonah', 'Talia', 'Eli', 'Aria', 'Isaac', 'Noa', 'Gabriel', 'Leah', 'Aaron',
  'Hannah', 'Levi', 'Abigail', 'Adam', 'Miriam', 'Seth', 'Shoshana', 'Max', 'Sarah',
  'Jake', 'Dani', 'Ryan', 'Rachel', 'Dylan', 'Jessica', 'Tyler', 'Becca', 'Jordan',
  'Tessa', 'Brett', 'Alana', 'Chase', 'Morgan', 'Cole', 'Sierra', 'Spencer', 'Skylar',
  'Jared', 'Kayla', 'Brandon', 'Samantha', 'Corey', 'Lauren', 'Drew', 'Danielle',
  'Scott', 'Michelle', 'Todd', 'Alexis', 'Dean', 'Brooke', 'Matt', 'Lindsey',
  'Josh', 'Katie', 'Ben', 'Jen', 'Zach', 'Ali', 'Dov', 'Batya', 'Rafi', 'Shira',
  'Ari', 'Tova', 'Moshe', 'Chana', 'Dovid', 'Rivka', 'Yoni', 'Aviva',
];

const NA_LAST = [
  'Goldstein', 'Schwartz', 'Cohen', 'Shapiro', 'Klein', 'Rosen', 'Kaplan', 'Friedman',
  'Weiss', 'Stern', 'Blum', 'Gross', 'Sherman', 'Hoffman', 'Gordon', 'Green',
  'Silver', 'Gold', 'Diamond', 'Pearl', 'Crystal', 'Rubin', 'Katz', 'Levy',
  'Siegel', 'Bernstein', 'Epstein', 'Weinstein', 'Steinberg', 'Goldberg', 'Rosenberg',
  'Greenberg', 'Silverman', 'Goldman', 'Feldman', 'Rosenbaum', 'Lieberman', 'Horowitz',
  'Zimmerman', 'Kessler', 'Adler', 'Baum', 'Berg', 'Brooks', 'Fisher', 'Frank',
  'Goodman', 'Handler', 'Jacobs', 'Miller', 'Price', 'Reed', 'Sage', 'Shore',
  'Stone', 'Wolf', 'Young', 'Fox', 'Moss', 'Ross', 'Hart', 'Mason',
];

const LATAM_FIRST = [
  'Diego', 'Valentina', 'Mateo', 'Camila', 'Santiago', 'Isabella', 'Alejandro',
  'Sofia', 'Lucas', 'Mariana', 'Sebastian', 'Gabriela', 'Nicolas', 'Ana', 'Daniel',
  'Laura', 'Andres', 'Paula', 'Felipe', 'Catalina', 'Tomas', 'Natalia', 'Rafael',
  'Carolina', 'Miguel', 'Fernanda', 'Carlos', 'Monica', 'Pablo', 'Elena',
  'Fernando', 'Daniela', 'Ricardo', 'Maria', 'Eduardo', 'Lucia', 'Marco', 'Julia',
];

const LATAM_LAST = [
  'Goldenberg', 'Rabinovitch', 'Levy', 'Kogan', 'Wainstein', 'Berman', 'Feldman',
  'Fridman', 'Gutman', 'Halperin', 'Mizrahi', 'Rubinstein', 'Szerman', 'Tenenbaum',
  'Wexler', 'Zilberman', 'Cohen', 'Levi', 'Segal', 'Schwartzman', 'Nudelman',
  'Brodsky', 'Chernoff', 'Lipsky', 'Maltz', 'Stein', 'Bloch', 'Groisman',
];

const AU_FIRST = [
  'Jack', 'Charlotte', 'William', 'Amelia', 'Oliver', 'Isla', 'Thomas', 'Mia',
  'James', 'Harper', 'Noah', 'Ella', 'Liam', 'Grace', 'Henry', 'Ava', 'Leo',
  'Zoe', 'Ethan', 'Ruby', 'Max', 'Sophie', 'Sam', 'Lily', 'Luke', 'Chloe',
  'Josh', 'Emily', 'Ben', 'Olivia', 'Ryan', 'Emma', 'Zach', 'Poppy',
];

const AU_LAST = [
  'Goldberg', 'Leibler', 'Pratt', 'Lowy', 'Smorgon', 'Besen', 'Gandel',
  'Roth', 'Abeles', 'Kliger', 'Kahn', 'Wertheim', 'Lustig', 'Freund', 'Engel',
  'Bloom', 'Hart', 'Marks', 'Glass', 'Fox', 'Stone', 'Silver', 'Green', 'Stern',
  'Moss', 'Pearl', 'Diamond', 'Price', 'Wise', 'Rose',
];

const SA_FIRST = [
  'Michael', 'Sarah', 'Daniel', 'Jessica', 'Adam', 'Nicole', 'David', 'Tamara',
  'Jason', 'Natasha', 'Ryan', 'Leanne', 'Grant', 'Kerry', 'Craig', 'Michelle',
  'Gary', 'Candice', 'Marc', 'Lauren', 'Brett', 'Tanya', 'Warren', 'Lisa',
  'Bradley', 'Simone', 'Dean', 'Hayley', 'Keith', 'Robyn',
];

const SA_LAST = [
  'Memory', // replaced at runtime via compound generator
];

// ── Handle generation ────────────────────────────────────────────────────────

function generateHandle(first: string, last: string, idx: number): string {
  const f = first.toLowerCase().replace(/[^a-z]/g, '');
  const l = last.toLowerCase().replace(/[^a-z]/g, '');
  const patterns = [
    () => `${f}${l}`,                          // noamlevi
    () => `${f}.${l}`,                          // noam.levi
    () => `${f}_${l}`,                          // noam_levi
    () => `${f}${l[0]}`,                        // noaml
    () => `${f}.${l[0]}`,                       // noam.l
    () => `${f}_${l.slice(0, 3)}`,              // noam_lev
    () => `${f[0]}${l}`,                        // nlevi
    () => `${f}`,                               // noam
    () => `the${f}`,                            // thenoam
    () => `${f}${l}${(idx % 99) + 1}`,          // noamlevi42
    () => `${f}.${l[0]}${(idx % 9) + 1}`,       // noam.l3
    () => `${f}${(idx % 99) + 1}`,              // noam42
    () => `just${f}`,                           // justnoam
    () => `${l}.${f}`,                          // levi.noam
    () => `real${f}`,                           // realnoam
    () => `${f}${l.slice(0, 2)}`,               // noamle
  ];
  return patterns[idx % patterns.length]();
}

// ── Beacon templates ─────────────────────────────────────────────────────────

const BEACON_TEMPLATES = [
  { raw: 'Looking for a chevruta to study Talmud together weekly', intent: 'Seeking study partner for Talmud', keywords: '["chevruta","talmud","study","weekly","learning"]' },
  { raw: 'Anyone want to start a book club? I have so many unread books on my shelf', intent: 'Seeking book club members', keywords: '["book club","reading","books","literature"]' },
  { raw: 'Studying for the bar exam, would love a study buddy in my timezone', intent: 'Seeking study partner for bar exam', keywords: '["bar exam","study","law","study buddy"]' },
  { raw: 'Learning Hebrew online and looking for a conversation partner to practice with', intent: 'Seeking Hebrew language practice partner', keywords: '["hebrew","language","practice","conversation"]' },
  { raw: 'Taking an online data science course, anyone else learning Python?', intent: 'Seeking coding study partner', keywords: '["data science","python","coding","online course"]' },
  { raw: 'Want to learn more about Jewish philosophy. Anyone up for a weekly discussion?', intent: 'Seeking Jewish philosophy discussion group', keywords: '["jewish philosophy","discussion","weekly","learning"]' },
  { raw: 'Prepping for medical boards, any other med students out there?', intent: 'Seeking medical study partner', keywords: '["medical","boards","study","med student"]' },
  { raw: 'Looking to dive deeper into Kabbalah study with a small group', intent: 'Seeking Kabbalah study group', keywords: '["kabbalah","study","mysticism","jewish learning"]' },
  { raw: 'Guitar player looking for others to jam with on weekends', intent: 'Seeking guitar jam partners', keywords: '["guitar","jam","music","weekends"]' },
  { raw: 'Just started learning piano, anyone else a beginner?', intent: 'Seeking beginner piano buddy', keywords: '["piano","beginner","music","learning"]' },
  { raw: 'Singer-songwriter looking for musicians to collaborate with', intent: 'Seeking music collaboration', keywords: '["singer","songwriter","musicians","collaboration"]' },
  { raw: 'Putting together a Jewish music night for the community', intent: 'Organizing Jewish music event', keywords: '["jewish music","community","event","concert"]' },
  { raw: 'Playing acoustic guitar at local open mics, come hang!', intent: 'Inviting people to open mic nights', keywords: '["acoustic guitar","open mic","live music","hangout"]' },
  { raw: 'Looking for a co-founder for my fintech startup idea', intent: 'Seeking startup co-founder', keywords: '["co-founder","startup","fintech","business partner"]' },
  { raw: 'Real estate developer seeking JV partners for mixed-use projects', intent: 'Seeking real estate joint venture partners', keywords: '["real estate","joint venture","development","commercial"]' },
  { raw: 'Marketing consultant looking to connect with other Jewish professionals', intent: 'Seeking professional networking', keywords: '["marketing","consultant","networking","professionals"]' },
  { raw: 'Launching a new e-commerce brand, looking for mentors who have been there', intent: 'Seeking e-commerce mentorship', keywords: '["ecommerce","mentor","brand","startup"]' },
  { raw: 'CPA here, happy to chat taxes or connect with other finance folks', intent: 'Offering tax advice and seeking finance professionals', keywords: '["CPA","taxes","finance","accounting","networking"]' },
  { raw: 'Tech recruiter - always looking to help people land their next role', intent: 'Offering tech recruitment help', keywords: '["recruiter","tech","jobs","hiring","career"]' },
  { raw: 'New to the city and looking to make friends!', intent: 'Seeking social connections in new city', keywords: '["new","city","friends","social"]' },
  { raw: 'Mom of 3 looking to connect with other Jewish moms in my area', intent: 'Seeking Jewish mom connections', keywords: '["mom","parenting","jewish moms","community"]' },
  { raw: 'Planning a Shabbat dinner group, who wants in?', intent: 'Organizing Shabbat dinner group', keywords: '["shabbat","dinner","hosting","community"]' },
  { raw: 'Looking for running buddies, I do 5Ks and half marathons', intent: 'Seeking running partners', keywords: '["running","5K","half marathon","fitness"]' },
  { raw: 'Want to start a weekly board game night, any takers?', intent: 'Organizing board game night', keywords: '["board games","game night","social","weekly"]' },
  { raw: "Jewish singles in their 30s, let's organize something fun!", intent: 'Seeking Jewish singles events', keywords: '["singles","dating","30s","social events"]' },
  { raw: 'Dog owner looking for other Jewish dog lovers to hit the park with', intent: 'Seeking dog owner friends', keywords: '["dogs","dog park","pet owners","social"]' },
  { raw: 'Yoga enthusiast looking for a meditation group', intent: 'Seeking yoga and meditation group', keywords: '["yoga","meditation","mindfulness","wellness"]' },
  { raw: 'Kosher foodie here! Always looking for restaurant recs and cooking buddies', intent: 'Seeking kosher food enthusiasts', keywords: '["kosher","foodie","restaurants","cooking"]' },
  { raw: 'Want to swap Passover recipes? I have an amazing brisket recipe', intent: 'Seeking Passover recipe exchange', keywords: '["passover","recipes","brisket","cooking","pesach"]' },
  { raw: 'Starting a challah baking group, all skill levels welcome', intent: 'Organizing challah baking group', keywords: '["challah","baking","bread","cooking group"]' },
  { raw: 'Traveling to Israel next month, looking for tips and meetups!', intent: 'Seeking Israel travel advice', keywords: '["israel","travel","tips","meetup"]' },
  { raw: 'Digital nomad, currently in Lisbon. Any other Jewish travelers here?', intent: 'Seeking Jewish digital nomad connections', keywords: '["digital nomad","travel","lisbon","remote work"]' },
  { raw: 'Filmmaker looking for fellow Jewish creatives to collaborate with', intent: 'Seeking creative collaboration', keywords: '["filmmaker","creative","film","collaboration"]' },
  { raw: 'Writer working on a novel with Jewish themes, looking for beta readers', intent: 'Seeking beta readers for novel', keywords: '["writer","novel","jewish themes","beta readers"]' },
  { raw: 'Photographer doing a project on Jewish communities worldwide', intent: 'Seeking subjects for photography project', keywords: '["photographer","jewish communities","art","documentary"]' },
  { raw: 'Full-stack dev looking for other Jewish developers to build side projects with', intent: 'Seeking developer collaboration', keywords: '["developer","full stack","side projects","coding"]' },
  { raw: 'Working in AI/ML and curious to connect with others in the space', intent: 'Seeking AI/ML professional connections', keywords: '["AI","machine learning","tech","networking"]' },
  { raw: 'UX designer looking to connect with other designers in the community', intent: 'Seeking designer networking', keywords: '["UX","design","UI","networking","creative"]' },
  { raw: 'Looking for volunteer opportunities, especially with kids', intent: 'Seeking volunteer opportunities with children', keywords: '["volunteer","kids","community service","teaching"]' },
  { raw: 'Organizing a chesed project and need helpers!', intent: 'Seeking volunteers for chesed project', keywords: '["chesed","volunteer","community","helping"]' },
];

const MIAMI_BEACONS = {
  investment: [
    { raw: 'Angel investor looking for early-stage startups in South Florida', intent: 'Seeking startup investment opportunities', keywords: '["angel investor","startups","investment","south florida"]' },
    { raw: 'Seeking investment opportunities in Miami real estate and tech', intent: 'Seeking investment opportunities in real estate and tech', keywords: '["investment","miami","real estate","tech","opportunities"]' },
    { raw: 'Looking for co-investors for a commercial property deal in Aventura', intent: 'Seeking co-investors for real estate', keywords: '["co-investors","commercial","real estate","aventura","miami"]' },
    { raw: 'VC associate always looking for the next big thing in Miami tech', intent: 'Seeking tech investment deals', keywords: '["venture capital","tech","miami","startups","investing"]' },
    { raw: 'Interested in crypto and DeFi investment groups in Miami', intent: 'Seeking crypto investment community', keywords: '["crypto","defi","investment","miami","blockchain"]' },
  ],
  pickleball: [
    { raw: 'Pickleball obsessed! Looking for partners at Flamingo Park', intent: 'Seeking pickleball partners in Miami Beach', keywords: '["pickleball","flamingo park","miami beach","sports"]' },
    { raw: 'Anyone play pickleball in Aventura? Looking for a regular doubles group', intent: 'Seeking pickleball doubles group', keywords: '["pickleball","aventura","doubles","regular group"]' },
    { raw: 'New to pickleball but addicted already, looking for beginners to play with', intent: 'Seeking beginner pickleball partners', keywords: '["pickleball","beginner","learning","miami"]' },
    { raw: 'Pickleball league forming in Sunny Isles, DM me if interested!', intent: 'Organizing pickleball league', keywords: '["pickleball","league","sunny isles","sports"]' },
    { raw: 'Looking for competitive pickleball players, 3.5+ rating', intent: 'Seeking competitive pickleball players', keywords: '["pickleball","competitive","3.5 rating","sports"]' },
  ],
  coffee: [
    { raw: "Let's do coffee! Always happy to meet new people in Miami", intent: 'Seeking casual coffee meetups', keywords: '["coffee","meetup","miami","social","networking"]' },
    { raw: 'Coffee lover looking for a regular coffee buddy in Brickell', intent: 'Seeking coffee partner in Brickell', keywords: '["coffee","brickell","regular meetup","social"]' },
    { raw: 'Anyone want to check out the new coffee spots in Wynwood this weekend?', intent: 'Seeking coffee exploration partner', keywords: '["coffee","wynwood","weekend","explore","miami"]' },
    { raw: 'Remote worker looking for coffee shop work buddies in Miami', intent: 'Seeking co-working coffee companions', keywords: '["remote work","coffee shop","coworking","miami"]' },
    { raw: 'Morning person, love grabbing coffee and chatting about life and business', intent: 'Seeking morning coffee networking', keywords: '["coffee","morning","networking","business","social"]' },
  ],
};

// ── Message templates ────────────────────────────────────────────────────────

const TZ_MSG = {
  intro: [
    "Hey everyone! Just joined TribeLife, excited to be here",
    "Hi! I'm new here, just downloaded the app today. This is awesome!",
    "Shalom! First time posting, love the concept of this app",
    "Hey all, just found this community. So glad this exists!",
    "Hi! Just moved to a new city and looking to connect with other Jews here",
    "What's up everyone? Just getting started on TribeLife",
    "Hello hello! A friend recommended this app and I'm loving it already",
    "New here! The timezone-based community idea is genius",
    "Yo! Just signed up. Anyone active in this room?",
    "Hey fam, just joined. Excited to meet everyone!",
    "Just checking this out for the first time. Seems really cool!",
    "Shalom shalom! Love that this exists. Finally an app for us",
  ],
  general: [
    "Has anyone tried the beacon feature? I just set mine up",
    "The matching feature is really cool, I got paired with someone with similar interests",
    "Love how active this room is. Feels like a real community",
    "Anyone have restaurant recommendations? Looking for good kosher spots",
    "Just had the best Shabbat dinner last week, wish I could share the recipes",
    "Who else is working from home today? This timezone room keeps me company",
    "Random question: what's everyone reading right now?",
    "This community is growing so fast, love to see it!",
    "Good morning everyone! Hope you all have a great day",
    "Anyone else find it hard to disconnect on Shabbat? Working on it...",
    "Just wanted to say this is such a positive community. You all are great",
    "Pro tip: the beacon feature is amazing for finding people with similar interests",
    "Does anyone here play any instruments? Would love to connect with musicians",
    "Happy to help anyone who's new here! Feel free to DM me",
    "Love the vibe in this room. This is what the internet should be",
    "Thinking about starting a local meetup, anyone interested?",
    "Just made the best challah of my life and I'm unreasonably proud",
    "Anyone else doing a digital detox except for TribeLife? Lol",
    "This app reminded me how important community is. Grateful for this space",
    "Quick question: how do you all balance work and community involvement?",
  ],
  passover: [
    "Chag Pesach Sameach everyone! Happy Passover!",
    "Wishing everyone a meaningful and joyful Pesach!",
    "Happy Passover to all! May your seder be filled with love and laughter",
    "Chag sameach! Anyone else already craving real bread? Day 1 and I'm struggling lol",
    "Happy Passover! Our seder table is set and I'm so excited",
    "Pesach sameach! Freedom is not just a story, it's a daily practice",
    "Happy Passover everyone! What's your favorite Pesach dish?",
    "Chag sameach from our family to yours! May this season bring peace",
    "It's that time of year again! Happy Passover, TribeLife fam",
    "Wishing the whole community a happy and kosher Pesach!",
    "First Passover away from family this year, grateful to have this community",
    "Happy Passover! My grandmother's matzo ball soup recipe is finally perfected",
    "Chag Pesach Sameach! Let's appreciate the freedom we have together",
    "The best part of Passover is gathering with people you love. Happy Pesach!",
    "Sending Passover love to everyone in this room! Chag sameach!",
    "Four cups of wine and counting... Happy Passover everyone!",
  ],
  engage: [
    "That's such a great point! Totally agree",
    "Welcome! So glad you joined, you're going to love it here",
    "Ha, same! I thought I was the only one who felt that way",
    "This is why I love this community",
    "Couldn't have said it better myself",
    "100%. You nailed it",
    "Thanks for sharing that, really appreciate the perspective",
    "Exactly what I was thinking!",
    "Love this energy!",
    "Yes! So glad someone said it",
    "Wow that's so cool, tell me more!",
    "Welcome to the family!",
    "Great question! Would love to hear what everyone thinks",
    "So true. This community gets it",
    "This made my day, thank you!",
  ],
};

const GLOBE_MSG: Record<string, string[]> = {
  'town-square': [
    "Good morning/afternoon/evening wherever you are in the world! Love that we're all here",
    "Shalom from across the globe! What a time to be alive and connected",
    "Anyone else amazed at how many of us there are worldwide?",
    "Just popping in to say I love this global community. Jews everywhere, united!",
    "Happy to be here with Jews from every timezone. This is special",
    "From Israel to Australia to New York — we're all here. Amazing",
    "Town Square really is the digital town square. Love it",
    "Sending love and good vibes to the entire TribeLife community",
    "What a beautiful thing, Jews from everywhere chatting in one place",
    "Is it just me or is Town Square the best room in the app?",
    "Chag Pesach Sameach to ALL of TribeLife! Happy Passover!",
    "Wishing everyone a wonderful Passover, no matter where you are in the world!",
    "Happy Passover from our global family! May we all celebrate in freedom",
  ],
  'north-america': [
    "Happy Passover North America! Who's hosting seder this year?",
    "Love being part of the North American Jewish community here",
    "Anyone in the NYC area? Would love to organize a meetup",
    "West Coast vs East Coast seder debate: go!",
    "Canadian Jews represent! Hello from Toronto",
    "Just had the most amazing Shabbat dinner in Brooklyn",
    "Miami checking in! Loving the community vibes down here",
    "LA Jews, where are you at? Let's get together!",
    "Happy Passover from Chicago! Deep dish and matzo, name a better duo",
    "Boston fam! Anyone doing a community seder?",
  ],
  israel: [
    "!שלום לכולם, מה המצב",
    "Shalom from Tel Aviv! Love this community",
    "Anyone in Jerusalem? Let's grab coffee sometime",
    "Chag Pesach Sameach from the Holy Land!",
    "Beer Sheva checking in! Yes, we exist lol",
    "Haifa Bay area — who else is here?",
    "Love seeing so many Israelis on TribeLife",
    "Happy Passover from Israel! Extra special to celebrate here",
    "Anyone in Raanana? Looking for English speakers to hang with",
    "Tel Aviv startup scene + TribeLife = perfect combo",
    "Jerusalem at sunset never gets old. Chag sameach everyone!",
    "Wishing everyone from Eilat to the Golan a wonderful Pesach",
  ],
  europe: [
    "Shalom from Paris! The European Jewish community is alive and well",
    "Berlin checking in! Growing Jewish community here",
    "Amsterdam Jews unite! Love seeing this room active",
    "Happy Passover from Budapest! Beautiful seders here",
    "Vienna has such a rich Jewish history. Grateful to be part of this community",
    "Anyone in Zurich? Jewish community is small but mighty",
    "Chag Pesach Sameach from Rome! Jewish life here goes back 2000 years",
    "Stockholm Jews checking in! We may be few but we're enthusiastic",
    "Happy Passover from Madrid! Sephardic traditions are alive and well",
    "Prague has a beautiful Jewish quarter. History is everywhere",
  ],
  'uk-ireland': [
    "London calling! Great to see UK Jews on TribeLife",
    "Manchester Jewish community is thriving! Hello everyone",
    "Dublin checking in — small but beautiful Jewish community here",
    "Happy Passover from London! Golders Green seder life",
    "Leeds Jews represent! Yes there are more than 3 of us",
    "Loving the UK Jewish community on here. Shabbat shalom everyone!",
    "Happy Pesach from Glasgow! Scottish Jews keeping the flame alive",
  ],
  'latin-america': [
    "Buenos Aires Jewish community checking in! Hola!",
    "Shalom from Sao Paulo! Largest Jewish community in Latin America",
    "Mexico City Jews, where are you?",
    "Happy Passover from Santiago! Chilean Jewish community sends love",
    "Buenos Aires has the best Jewish deli scene outside of NYC, fight me",
    "Lima Jewish community is small but so warm. Chag sameach!",
  ],
  'australia-nz': [
    "G'day from Melbourne! Biggest Jewish community in Australia",
    "Sydney Jews checking in! Love this app",
    "Auckland has a lovely little Jewish community. Shalom!",
    "Happy Passover from Down Under! Yes we celebrate in autumn lol",
    "Perth Jews exist! All 12 of us are here on TribeLife",
    "Melbourne bagels might rival NYC ones. I said what I said",
  ],
  'south-africa': [
    "Howzit from Cape Town! SA Jewish community is special",
    "Joburg Jews checking in! Love this community",
    "Happy Passover from South Africa! Braai and matzo, only here",
    "SA Jewish community punches way above its weight. Proud to be here",
    "Durban checking in! Small community but lots of love",
  ],
};

// ── DM templates ─────────────────────────────────────────────────────────────

const DM_TEMPLATES = [
  [
    { s: 0, t: "Hey! Saw your beacon about studying Talmud. I've been looking for a chevruta!" },
    { s: 1, t: "Oh awesome! What's your background? I'm intermediate level" },
    { s: 0, t: "Similar! I studied in yeshiva for a year after college. What tractate are you on?" },
    { s: 1, t: "Just starting Bava Metzia. Would love to do weekly sessions" },
    { s: 0, t: "Perfect, I'm free Tuesday and Thursday evenings. What works for you?" },
    { s: 1, t: "Tuesdays are great! Let's start next week?" },
    { s: 0, t: "Done! Looking forward to it" },
  ],
  [
    { s: 0, t: "Hi there! Welcome to TribeLife! I see you're new" },
    { s: 1, t: "Thank you! Yeah just downloaded it today. This is really cool" },
    { s: 0, t: "It really is! The beacon feature is my favorite — have you tried it?" },
    { s: 1, t: "Not yet, what is it exactly?" },
    { s: 0, t: "You post what you're looking for or offering, and it matches you with similar people" },
    { s: 1, t: "Oh that's genius! Setting one up now" },
  ],
  [
    { s: 0, t: "Hey! I saw you're also in Miami. Want to grab coffee sometime?" },
    { s: 1, t: "For sure! I'm in Brickell. Where are you?" },
    { s: 0, t: "Aventura! But I'm downtown a lot. How about that new place on Brickell Ave?" },
    { s: 1, t: "Love it. How's Thursday morning?" },
    { s: 0, t: "Perfect. See you there at 10?" },
    { s: 1, t: "It's a date! Well, a friend date lol. See you Thursday!" },
  ],
  [
    { s: 0, t: "Chag sameach! Are you doing anything for Passover?" },
    { s: 1, t: "Chag sameach! Yes! Hosting a seder for the first time actually" },
    { s: 0, t: "That's amazing! How many people?" },
    { s: 1, t: "About 15. I'm nervous but excited" },
    { s: 0, t: "You'll be great! If you need any recipes, I have my grandma's haroset recipe that's a showstopper" },
    { s: 1, t: "Yes please! DM it to me, I'd love that" },
    { s: 0, t: "Sending it now. And remember — the best seders are the ones with the most love, not the most perfect food" },
    { s: 1, t: "That's so sweet. Thank you! Happy Passover!" },
  ],
  [
    { s: 0, t: "Hey! Saw your beacon about pickleball. I play at Flamingo Park!" },
    { s: 1, t: "No way! I just started going there. What days do you play?" },
    { s: 0, t: "Usually Saturday nights and Tuesday mornings" },
    { s: 1, t: "I could do Tuesday mornings! What's your level?" },
    { s: 0, t: "Intermediate, maybe 3.5. You?" },
    { s: 1, t: "About the same! Let's rally Tuesday?" },
    { s: 0, t: "Let's do it! I'll be there at 8am" },
  ],
  [
    { s: 0, t: "Hi! Your beacon about investment opportunities caught my eye" },
    { s: 1, t: "Hey! Yes, I'm always looking at deals. What's your focus?" },
    { s: 0, t: "Mostly early-stage tech, but open to real estate too" },
    { s: 1, t: "Interesting! I have a few things in the pipeline. Want to meet up and chat?" },
    { s: 0, t: "Absolutely. Happy to share what I'm seeing too. Next week?" },
    { s: 1, t: "Works for me. I'll DM you my calendar link" },
  ],
  [
    { s: 0, t: "Hey! I noticed we both play guitar. What kind of music are you into?" },
    { s: 1, t: "Hey! Mostly folk and some Israeli music. You?" },
    { s: 0, t: "Classic rock and blues mostly, but I love Israeli music too" },
    { s: 1, t: "Nice! Ever play Shlomo Carlebach stuff?" },
    { s: 0, t: "All the time! Those melodies are incredible" },
    { s: 1, t: "We should jam sometime! Maybe put together a little Shabbat set" },
    { s: 0, t: "I'm so down. That would be amazing" },
  ],
  [
    { s: 0, t: "Shalom! Just wanted to introduce myself — I'm new in town" },
    { s: 1, t: "Welcome! Where did you move from?" },
    { s: 0, t: "Tel Aviv, actually. Big change!" },
    { s: 1, t: "Wow, that IS a change! How are you settling in?" },
    { s: 0, t: "Slowly but surely. TribeLife has helped a lot honestly" },
    { s: 1, t: "Glad to hear that! If you need anything, don't hesitate to reach out" },
    { s: 0, t: "Thank you so much, that means a lot!" },
  ],
  [
    { s: 0, t: "Happy Passover! First time celebrating away from family" },
    { s: 1, t: "Oh no! Do you have somewhere to go for seder?" },
    { s: 0, t: "Not yet honestly, was thinking of doing a small one at home" },
    { s: 1, t: "Come to ours! We always have room. The more the merrier" },
    { s: 0, t: "Really?? That would be incredible. Are you sure?" },
    { s: 1, t: "Absolutely! No one should be alone for Pesach. I'll DM you the details" },
    { s: 0, t: "You just made my whole week. Thank you so much!" },
    { s: 1, t: "That's what community is for! Chag sameach!" },
  ],
  [
    { s: 0, t: "Hey Rose! Saw your beacons — you're into pickleball AND investing? My kind of person!" },
    { s: 1, t: "Ha! Yes, that's me! Jack of all trades over here" },
    { s: 0, t: "I just got into pickleball last month. Totally addicted" },
    { s: 1, t: "It's SO addicting right?! Where do you play?" },
    { s: 0, t: "Flamingo Park mostly. You?" },
    { s: 1, t: "Same! We should definitely play. And I'd love to chat about the Miami startup scene too" },
    { s: 0, t: "Perfect combo: pickleball then coffee to talk deals?" },
    { s: 1, t: "Now you're speaking my language! Let's make it happen" },
  ],
];

const QUICK_DM = [
  [
    { s: 0, t: "Hey! Saw you on TribeLife, wanted to say hi" },
    { s: 1, t: "Hi! Nice to meet you! How are you liking the app?" },
    { s: 0, t: "Loving it! The community is so warm" },
    { s: 1, t: "Right? It's such a special space. Welcome!" },
  ],
  [
    { s: 0, t: "Chag sameach! Happy Passover!" },
    { s: 1, t: "Chag sameach to you too! Having a good yom tov?" },
    { s: 0, t: "The best! Family seder was amazing" },
  ],
  [
    { s: 0, t: "Hey I'm new here, any tips?" },
    { s: 1, t: "Welcome! Check out the beacon feature, it's amazing for finding people with similar interests" },
    { s: 0, t: "Oh cool, I'll try that. Thanks!" },
  ],
  [
    { s: 0, t: "Hi! Loved your message in the timezone room" },
    { s: 1, t: "Thank you! It's so nice when people actually read and respond" },
    { s: 0, t: "This community is different. People actually care" },
    { s: 1, t: "That's what makes it special. Glad you're here!" },
  ],
];

// ── Region definitions ───────────────────────────────────────────────────────

interface RegionDef {
  timezones: string[];
  globe: string;
  first: string[];
  last: string[];
  count: number;
}

const REGIONS: RegionDef[] = [
  { timezones: ['America/New_York'], globe: 'north-america', first: NA_FIRST, last: NA_LAST, count: 150 },
  { timezones: ['America/Chicago'], globe: 'north-america', first: NA_FIRST, last: NA_LAST, count: 40 },
  { timezones: ['America/Denver'], globe: 'north-america', first: NA_FIRST, last: NA_LAST, count: 25 },
  { timezones: ['America/Los_Angeles'], globe: 'north-america', first: NA_FIRST, last: NA_LAST, count: 80 },
  { timezones: ['America/Toronto'], globe: 'north-america', first: NA_FIRST, last: NA_LAST, count: 30 },
  { timezones: ['Asia/Jerusalem'], globe: 'israel', first: ISRAELI_FIRST, last: ISRAELI_LAST, count: 120 },
  { timezones: ['Europe/Paris', 'Europe/Berlin', 'Europe/Amsterdam', 'Europe/Rome', 'Europe/Vienna', 'Europe/Zurich'], globe: 'europe', first: EURO_FIRST, last: EURO_LAST, count: 80 },
  { timezones: ['Europe/Budapest', 'Europe/Warsaw', 'Europe/Prague', 'Europe/Bucharest', 'Europe/Stockholm'], globe: 'europe', first: EURO_FIRST, last: EURO_LAST, count: 40 },
  { timezones: ['Europe/London', 'Europe/Dublin'], globe: 'uk-ireland', first: UK_FIRST, last: UK_LAST, count: 45 },
  { timezones: ['America/Argentina/Buenos_Aires', 'America/Sao_Paulo', 'America/Mexico_City', 'America/Santiago'], globe: 'latin-america', first: LATAM_FIRST, last: LATAM_LAST, count: 35 },
  { timezones: ['Australia/Sydney', 'Australia/Melbourne', 'Pacific/Auckland'], globe: 'australia-nz', first: AU_FIRST, last: AU_LAST, count: 30 },
  { timezones: ['Africa/Johannesburg'], globe: 'south-africa', first: SA_FIRST, last: SA_LAST, count: 20 },
];

// ── Pseudo-random (seeded for reproducibility) ──────────────────────────────

let _seed = 42;
function rand(): number {
  _seed = (_seed * 16807 + 0) % 2147483647;
  return (_seed - 1) / 2147483646;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

function pickN<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => rand() - 0.5);
  return shuffled.slice(0, n);
}

function shuffle<T>(arr: T[]): T[] {
  const r = [...arr];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🎬  Seeding promo data (700+ users, beacons, messages, conversations)…\n');

  // Generate SA Jewish surnames from compound parts (Ashkenazi origin)
  const saRegion = REGIONS.find(r => r.globe === 'south-africa')!;
  const prefixes = ['Gold', 'Silver', 'Rosen', 'Green', 'Stein', 'Blum', 'Kap', 'Fried'];
  const suffixes = ['berg', 'man', 'stein', 'thal', 'field', 'baum', 'lan', 'ner'];
  const saNames: string[] = [];
  for (let i = 0; i < prefixes.length; i++) {
    for (let j = 0; j < 3; j++) {
      saNames.push(prefixes[i] + suffixes[(i + j) % suffixes.length]);
    }
  }
  saRegion.last = saNames;

  // ── Step 1: Generate all users ──────────────────────────────────────────

  const allUsers: MockUser[] = [];
  const usedHandles = new Set<string>();
  const usedEmails = new Set<string>();
  let gIdx = 0;

  // @rose user — always first, Miami, premium
  allUsers.push({
    name: 'Rose',
    handle: 'rose',
    email: 'rose.promo@tribelife.app',
    timezone: 'America/New_York',
    isPremium: true,
  });
  usedHandles.add('rose');
  usedEmails.add('rose.promo@tribelife.app');

  for (const region of REGIONS) {
    for (let i = 0; i < region.count; i++) {
      const first = region.first[i % region.first.length];
      const last = region.last[i % region.last.length];
      const tz = region.timezones[i % region.timezones.length];

      let handle = generateHandle(first, last, gIdx);
      let att = 0;
      while (usedHandles.has(handle) && att < 20) {
        att++;
        handle = generateHandle(first, last, gIdx + att * 7);
      }
      if (usedHandles.has(handle)) handle = `${handle}${gIdx}`;

      const emailBase = `${first.toLowerCase()}.${last.toLowerCase().replace(/[^a-z]/g, '')}`;
      let email = `${emailBase}.promo@tribelife.app`;
      if (usedEmails.has(email)) email = `${emailBase}${gIdx}.promo@tribelife.app`;

      allUsers.push({
        name: `${first} ${last}`,
        handle,
        email,
        timezone: tz,
        isPremium: rand() < 0.15,
      });

      usedHandles.add(handle);
      usedEmails.add(email);
      gIdx++;
    }
  }

  console.log(`  📊 Generated ${allUsers.length} users\n`);

  // ── Step 2: Insert users ────────────────────────────────────────────────

  console.log('  💾 Inserting users…');
  const h2id = new Map<string, number>();

  for (const u of allUsers) {
    await db.execute(
      sql`INSERT INTO users (name, email, password_hash)
          VALUES (${u.name}, ${u.email}, ${`$promo$${u.handle}`})
          ON CONFLICT (email) DO NOTHING`
    );
    const row = await db.execute<{ id: number }>(
      sql`SELECT id FROM users WHERE email = ${u.email}`
    );
    const userId = row.rows[0].id;
    h2id.set(u.handle, userId);

    await db.execute(
      sql`INSERT INTO user_profiles (user_id, handle, timezone, is_premium)
          VALUES (${userId}, ${u.handle}, ${u.timezone}, ${u.isPremium})
          ON CONFLICT (user_id) DO UPDATE SET timezone = ${u.timezone}, is_premium = ${u.isPremium}`
    ).catch(() => {
      // Handle unique constraint on handle — skip if handle already taken
      console.log(`    ⚠️  Skipping profile for ${u.handle} (handle conflict)`);
    });
  }
  console.log(`  ✅ ${allUsers.length} users + profiles\n`);

  // ── Step 3: Beacons ─────────────────────────────────────────────────────

  console.log('  🔦 Creating beacons…');
  let bc = 0;
  const roseId = h2id.get('rose')!;
  const exp30d = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  // @rose: 3 Miami beacons
  for (const b of [pick(MIAMI_BEACONS.investment), pick(MIAMI_BEACONS.pickleball), pick(MIAMI_BEACONS.coffee)]) {
    await db.execute(
      sql`INSERT INTO beacons (user_id, raw_text, parsed_intent, keywords, timezone, is_active, is_sanitized, expires_at)
          VALUES (${roseId}, ${b.raw}, ${b.intent}, ${b.keywords}, ${'America/New_York'}, true, true, ${exp30d})`
    );
    bc++;
  }

  // Miami users: investment, pickleball, coffee beacons
  const miamiUsers = allUsers.filter(u => u.timezone === 'America/New_York' && u.handle !== 'rose');
  for (const u of pickN(miamiUsers, 15)) {
    const b = pick(MIAMI_BEACONS.investment);
    await db.execute(sql`INSERT INTO beacons (user_id, raw_text, parsed_intent, keywords, timezone, is_active, is_sanitized, expires_at) VALUES (${h2id.get(u.handle)!}, ${b.raw}, ${b.intent}, ${b.keywords}, ${u.timezone}, true, true, ${exp30d})`);
    bc++;
  }
  for (const u of pickN(miamiUsers, 12)) {
    const b = pick(MIAMI_BEACONS.pickleball);
    await db.execute(sql`INSERT INTO beacons (user_id, raw_text, parsed_intent, keywords, timezone, is_active, is_sanitized, expires_at) VALUES (${h2id.get(u.handle)!}, ${b.raw}, ${b.intent}, ${b.keywords}, ${u.timezone}, true, true, ${exp30d})`);
    bc++;
  }
  for (const u of pickN(miamiUsers, 10)) {
    const b = pick(MIAMI_BEACONS.coffee);
    await db.execute(sql`INSERT INTO beacons (user_id, raw_text, parsed_intent, keywords, timezone, is_active, is_sanitized, expires_at) VALUES (${h2id.get(u.handle)!}, ${b.raw}, ${b.intent}, ${b.keywords}, ${u.timezone}, true, true, ${exp30d})`);
    bc++;
  }

  // General beacons (~75% of users)
  for (const u of allUsers) {
    if (u.handle === 'rose') continue;
    if (rand() < 0.25) continue;
    const b = pick(BEACON_TEMPLATES);
    await db.execute(sql`INSERT INTO beacons (user_id, raw_text, parsed_intent, keywords, timezone, is_active, is_sanitized, expires_at) VALUES (${h2id.get(u.handle)!}, ${b.raw}, ${b.intent}, ${b.keywords}, ${u.timezone}, true, true, ${exp30d})`);
    bc++;
  }
  console.log(`  ✅ ${bc} beacons\n`);

  // ── Step 4: Beacon matches ──────────────────────────────────────────────

  console.log('  🤝 Creating beacon matches…');
  let mc = 0;
  const allB = await db.execute<{ id: number; user_id: number }>(
    sql`SELECT id, user_id FROM beacons WHERE is_active = true ORDER BY id`
  );
  const bByUser = new Map<number, number[]>();
  for (const r of allB.rows) {
    const list = bByUser.get(r.user_id) || [];
    list.push(r.id);
    bByUser.set(r.user_id, list);
  }

  const reasons = [
    'Both interested in similar activities in the same area',
    'Shared interest in community connection and networking',
    'Complementary goals — one seeking, one offering similar interests',
    'Geographic proximity and aligned schedules',
    'Similar professional interests and community engagement',
  ];

  // Rose matches
  const roseB = bByUser.get(roseId) || [];
  const otherB = allB.rows.filter(r => r.user_id !== roseId);
  for (const rb of roseB) {
    for (const ob of pickN(otherB, 5)) {
      await db.execute(
        sql`INSERT INTO beacon_matches (beacon_id, matched_beacon_id, similarity_score, match_reason)
            VALUES (${rb}, ${ob.id}, ${(0.7 + rand() * 0.25).toFixed(2)}, ${pick(reasons)})
            ON CONFLICT DO NOTHING`
      );
      mc++;
    }
  }

  // General matches
  for (let i = 0; i < 200; i++) {
    const a = pick(allB.rows);
    const b = pick(allB.rows);
    if (a.id === b.id || a.user_id === b.user_id) continue;
    await db.execute(
      sql`INSERT INTO beacon_matches (beacon_id, matched_beacon_id, similarity_score, match_reason)
          VALUES (${a.id}, ${b.id}, ${(0.6 + rand() * 0.35).toFixed(2)}, ${pick(reasons)})
          ON CONFLICT DO NOTHING`
    );
    mc++;
  }
  console.log(`  ✅ ${mc} beacon matches\n`);

  // ── Step 5: Timezone room messages ──────────────────────────────────────

  console.log('  💬 Creating timezone room messages…');
  let tzmc = 0;
  const uniqueTz = [...new Set(allUsers.map(u => u.timezone))];

  for (const tz of uniqueTz) {
    const roomId = `timezone:${tz}`;
    const tzUsers = allUsers.filter(u => u.timezone === tz);
    if (tzUsers.length < 3) continue;

    const existing = await db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM messages WHERE room_id = ${roomId} AND sender_id IN (
        SELECT id FROM users WHERE email LIKE '%.promo@tribelife.app'
      )`
    );
    if (parseInt(existing.rows[0].count) > 10) continue;

    const senders = pickN(tzUsers, Math.min(12, tzUsers.length));

    // Intros (3 days ago)
    for (const [i, msg] of pickN(TZ_MSG.intro, Math.min(4, senders.length)).entries()) {
      const sid = h2id.get(senders[i % senders.length].handle)!;
      const at = new Date(Date.now() - (4320 - i * 15) * 60000);
      await db.execute(sql`INSERT INTO messages (content, sender_id, room_id, created_at) VALUES (${msg}, ${sid}, ${roomId}, ${at})`);
      tzmc++;
    }

    // Engagement
    for (const [i, msg] of pickN(TZ_MSG.engage, 3).entries()) {
      const sid = h2id.get(senders[(i + 2) % senders.length].handle)!;
      const at = new Date(Date.now() - (4200 - i * 12) * 60000);
      await db.execute(sql`INSERT INTO messages (content, sender_id, room_id, created_at) VALUES (${msg}, ${sid}, ${roomId}, ${at})`);
      tzmc++;
    }

    // General (2 days ago)
    for (const [i, msg] of pickN(TZ_MSG.general, Math.min(8, senders.length)).entries()) {
      const sid = h2id.get(senders[i % senders.length].handle)!;
      const at = new Date(Date.now() - (2880 - i * 20) * 60000);
      await db.execute(sql`INSERT INTO messages (content, sender_id, room_id, created_at) VALUES (${msg}, ${sid}, ${roomId}, ${at})`);
      tzmc++;
    }

    // More engagement
    for (const [i, msg] of pickN(TZ_MSG.engage, 2).entries()) {
      const sid = h2id.get(senders[(i + 5) % senders.length].handle)!;
      const at = new Date(Date.now() - (2700 - i * 10) * 60000);
      await db.execute(sql`INSERT INTO messages (content, sender_id, room_id, created_at) VALUES (${msg}, ${sid}, ${roomId}, ${at})`);
      tzmc++;
    }

    // Passover (recent — 3 hours ago)
    for (const [i, msg] of pickN(TZ_MSG.passover, Math.min(5, senders.length)).entries()) {
      const sid = h2id.get(senders[i % senders.length].handle)!;
      const at = new Date(Date.now() - (180 - i * 15) * 60000);
      await db.execute(sql`INSERT INTO messages (content, sender_id, room_id, created_at) VALUES (${msg}, ${sid}, ${roomId}, ${at})`);
      tzmc++;
    }
  }
  console.log(`  ✅ ${tzmc} timezone room messages\n`);

  // ── Step 6: Globe room messages ─────────────────────────────────────────

  console.log('  🌍 Creating globe room messages…');
  let gmc = 0;

  for (const [slug, msgs] of Object.entries(GLOBE_MSG)) {
    const roomId = `globe:${slug}`;
    const regionUsers = slug === 'town-square'
      ? allUsers
      : allUsers.filter(u => REGIONS.some(r => r.globe === slug && r.timezones.includes(u.timezone)));
    if (regionUsers.length < 3) continue;

    const senders = pickN(regionUsers, Math.min(15, regionUsers.length));
    const ordered = shuffle(msgs);

    for (const [i, msg] of ordered.entries()) {
      const sid = h2id.get(senders[i % senders.length].handle)!;
      const at = new Date(Date.now() - (2000 - i * 60) * 60000);
      await db.execute(sql`INSERT INTO messages (content, sender_id, room_id, created_at) VALUES (${msg}, ${sid}, ${roomId}, ${at})`);
      gmc++;
    }
  }
  console.log(`  ✅ ${gmc} globe room messages\n`);

  // ── Step 7: DM conversations ────────────────────────────────────────────

  console.log('  📩 Creating DM conversations…');
  let dmc = 0;
  let cc = 0;

  for (const [idx, tmpl] of DM_TEMPLATES.entries()) {
    let u0: MockUser, u1: MockUser;
    if (idx === DM_TEMPLATES.length - 1) {
      // Rose pickleball+investing conversation
      u1 = allUsers[0]; // rose
      u0 = pick(allUsers.filter(u => u.handle !== 'rose' && u.timezone === 'America/New_York'));
    } else if (idx === 2) {
      // Coffee in Miami
      u0 = allUsers[0]; // rose
      u1 = pick(allUsers.filter(u => u.handle !== 'rose' && u.timezone === 'America/New_York'));
    } else {
      const pair = pickN(allUsers, 2);
      u0 = pair[0]; u1 = pair[1];
    }

    const uid0 = h2id.get(u0.handle)!;
    const uid1 = h2id.get(u1.handle)!;
    const base = 1200 - idx * 100;
    const cAt = new Date(Date.now() - base * 60000);
    const lAt = new Date(Date.now() - (base - tmpl.length * 8) * 60000);

    await db.execute(sql`INSERT INTO conversations (created_at, last_message_at) VALUES (${cAt}, ${lAt})`);
    const cRow = await db.execute<{ id: number }>(sql`SELECT id FROM conversations ORDER BY id DESC LIMIT 1`);
    const cid = cRow.rows[0].id;

    await db.execute(sql`INSERT INTO conversation_participants (conversation_id, user_id, joined_at) VALUES (${cid}, ${uid0}, ${cAt}) ON CONFLICT DO NOTHING`);
    await db.execute(sql`INSERT INTO conversation_participants (conversation_id, user_id, joined_at) VALUES (${cid}, ${uid1}, ${cAt}) ON CONFLICT DO NOTHING`);

    for (const [i, msg] of tmpl.entries()) {
      const sid = msg.s === 0 ? uid0 : uid1;
      const at = new Date(Date.now() - (base - i * 8) * 60000);
      await db.execute(sql`INSERT INTO messages (content, sender_id, conversation_id, created_at) VALUES (${msg.t}, ${sid}, ${cid}, ${at})`);
      dmc++;
    }
    cc++;
  }

  // 30 more quick DMs for volume
  for (let c = 0; c < 30; c++) {
    const pair = pickN(allUsers, 2);
    const uid0 = h2id.get(pair[0].handle)!;
    const uid1 = h2id.get(pair[1].handle)!;
    const base = 5000 + c * 200;
    const cAt = new Date(Date.now() - base * 60000);
    const tmpl = QUICK_DM[c % QUICK_DM.length];
    const lAt = new Date(Date.now() - (base - tmpl.length * 10) * 60000);

    await db.execute(sql`INSERT INTO conversations (created_at, last_message_at) VALUES (${cAt}, ${lAt})`);
    const cRow = await db.execute<{ id: number }>(sql`SELECT id FROM conversations ORDER BY id DESC LIMIT 1`);
    const cid = cRow.rows[0].id;

    await db.execute(sql`INSERT INTO conversation_participants (conversation_id, user_id, joined_at) VALUES (${cid}, ${uid0}, ${cAt}) ON CONFLICT DO NOTHING`);
    await db.execute(sql`INSERT INTO conversation_participants (conversation_id, user_id, joined_at) VALUES (${cid}, ${uid1}, ${cAt}) ON CONFLICT DO NOTHING`);

    for (const [i, msg] of tmpl.entries()) {
      const sid = msg.s === 0 ? uid0 : uid1;
      const at = new Date(Date.now() - (base - i * 10) * 60000);
      await db.execute(sql`INSERT INTO messages (content, sender_id, conversation_id, created_at) VALUES (${msg.t}, ${sid}, ${cid}, ${at})`);
      dmc++;
    }
    cc++;
  }
  console.log(`  ✅ ${cc} conversations, ${dmc} DMs\n`);

  // ── Step 8: Reactions ───────────────────────────────────────────────────

  console.log('  ❤️ Adding reactions…');
  let rc = 0;
  const recent = await db.execute<{ id: number; sender_id: number }>(
    sql`SELECT id, sender_id FROM messages WHERE sender_id IN (SELECT id FROM users WHERE email LIKE '%.promo@tribelife.app') ORDER BY created_at DESC LIMIT 200`
  );
  const emojis = ['❤️', '👍', '🔥', '😊', '🙌', '💪', '✡️', '🕎', '🥰', '😂'];
  for (const msg of recent.rows) {
    const n = Math.floor(rand() * 3) + 1;
    for (const reactor of pickN(allUsers, n)) {
      const rid = h2id.get(reactor.handle)!;
      if (rid === msg.sender_id) continue;
      await db.execute(sql`INSERT INTO reactions (message_id, user_id, emoji) VALUES (${msg.id}, ${rid}, ${pick(emojis)}) ON CONFLICT DO NOTHING`);
      rc++;
    }
  }
  console.log(`  ✅ ${rc} reactions\n`);

  // ── Step 9: Notifications for @rose ─────────────────────────────────────

  console.log('  🔔 Creating notifications for @rose…');
  const notifs = [
    { type: 'beacon_match', title: 'New Beacon Match!', body: 'Someone matched with your pickleball beacon', data: { beaconMatchId: 1 } },
    { type: 'beacon_match', title: 'New Beacon Match!', body: 'Someone matched with your investment beacon', data: { beaconMatchId: 2 } },
    { type: 'new_dm', title: 'New Message', body: 'You have a new direct message', data: { conversationId: 1 } },
    { type: 'system', title: 'Welcome to TribeLife!', body: 'Start by setting up your beacon to connect with others', data: {} },
  ];
  for (const n of notifs) {
    await db.execute(
      sql`INSERT INTO notifications (user_id, type, title, body, data) VALUES (${roseId}, ${n.type}, ${n.title}, ${n.body}, ${JSON.stringify(n.data)}::jsonb)`
    );
  }
  console.log('  ✅ Notifications created\n');

  // ── Summary ─────────────────────────────────────────────────────────────

  console.log('═══════════════════════════════════════════════════');
  console.log('🎬  Promo seed complete!');
  console.log(`    👥 ${allUsers.length} users`);
  console.log(`    🔦 ${bc} beacons`);
  console.log(`    🤝 ${mc} beacon matches`);
  console.log(`    💬 ${tzmc} timezone room messages`);
  console.log(`    🌍 ${gmc} globe room messages`);
  console.log(`    📩 ${dmc} DMs in ${cc} conversations`);
  console.log(`    ❤️ ${rc} reactions`);
  console.log('═══════════════════════════════════════════════════');

  await pool.end();
}

main().catch(err => {
  console.error('❌ Promo seed failed:', err);
  process.exit(1);
});
