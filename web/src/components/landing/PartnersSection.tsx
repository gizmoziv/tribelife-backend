import { motion } from 'framer-motion';

const partners = [
  'MARJCC',
  'I ❤️ JEWISH GIRLS',
  'LEMALA',
  'ESEK',
  'STILL DANCING',
];

// One group must be wider than any viewport, otherwise the -50% loop reveals a blank gap.
const REPEATS = 4;
const groupItems = Array.from({ length: REPEATS }, (_, r) =>
  partners.map((name) => ({ name, key: `${r}-${name}` })),
).flat();

const Separator = () => (
  <svg
    className="shrink-0 mx-8 w-5 h-5"
    viewBox="0 0 24 24"
    fill="none"
    stroke="url(#partners-separator-gradient)"
    strokeWidth="3"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7" />
  </svg>
);

const PartnerItem = ({ name }: { name: string }) => (
  <li className="shrink-0 flex items-center text-base md:text-lg font-display font-bold tracking-wide text-foreground whitespace-nowrap select-none">
    {name}
    <Separator />
  </li>
);

const PartnersSection = () => {
  return (
    <section id="partners" className="relative py-16 overflow-hidden">
      {/* Gradient shared by every separator (mirrors --gradient-warm) */}
      <svg width="0" height="0" className="absolute" aria-hidden="true">
        <defs>
          <linearGradient id="partners-separator-gradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="hsl(280, 60%, 55%)" />
            <stop offset="50%" stopColor="hsl(350, 75%, 58%)" />
            <stop offset="100%" stopColor="hsl(32, 95%, 55%)" />
          </linearGradient>
        </defs>
      </svg>

      <div className="container mx-auto px-6 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-10"
        >
          <h2 className="text-3xl md:text-4xl font-display font-bold text-foreground leading-[1.1] lowercase">
            <span className="normal-case">Our</span>{' '}
            <span className="gradient-text">partners</span>
          </h2>
        </motion.div>
      </div>

      {/* Marquee: the group is rendered twice and translated -50% for a seamless loop */}
      <div
        className="partners-marquee relative overflow-hidden"
        style={{
          maskImage:
            'linear-gradient(to right, transparent, black 10%, black 90%, transparent)',
          WebkitMaskImage:
            'linear-gradient(to right, transparent, black 10%, black 90%, transparent)',
        }}
      >
        <div className="partners-track flex w-max">
          <ul className="flex shrink-0 items-center">
            {groupItems.map((p) => (
              <PartnerItem key={p.key} name={p.name} />
            ))}
          </ul>
          <ul className="flex shrink-0 items-center" aria-hidden="true">
            {groupItems.map((p) => (
              <PartnerItem key={p.key} name={p.name} />
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
};

export default PartnersSection;
