import { motion } from 'framer-motion';

const partners = [
  'MARJCC',
  'I ❤️ JEWISH GIRLS',
  'LEMALA',
  'ESEK',
  'STILL DANCING (Documentary)',
];

const PartnerPill = ({ name }: { name: string }) => (
  <li className="shrink-0 gradient-border rounded-full px-8 py-4 mx-3 text-base md:text-lg font-display font-bold tracking-wide text-foreground whitespace-nowrap">
    {name}
  </li>
);

const PartnersSection = () => {
  return (
    <section id="partners" className="relative py-16 overflow-hidden">
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

      {/* Marquee: the list is rendered twice and translated -50% for a seamless loop */}
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
            {partners.map((p) => (
              <PartnerPill key={p} name={p} />
            ))}
          </ul>
          <ul className="flex shrink-0 items-center" aria-hidden="true">
            {partners.map((p) => (
              <PartnerPill key={p} name={p} />
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
};

export default PartnersSection;
