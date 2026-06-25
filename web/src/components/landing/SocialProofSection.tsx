import { motion } from 'framer-motion';
import { Users, Handshake, MapPin, Star } from 'lucide-react';

const stats = [
  { icon: Users, value: '5K+', label: 'Active Members', valueClass: 'text-3xl md:text-4xl', delay: 0 },
  { icon: Handshake, value: '100s', label: 'Matches Made', valueClass: 'text-3xl md:text-4xl', delay: 0.1 },
  { icon: MapPin, value: 'Global + Local', label: 'Time Zone Chats', valueClass: 'text-2xl', delay: 0.2 },
  { icon: Star, value: '5 ★', label: 'App Store Rating', valueClass: 'text-3xl md:text-4xl', delay: 0.3 },
];

const SocialProofSection = () => {
  return (
    <section id="community" className="relative py-24 overflow-hidden">
      {/* Background accent */}
      <div className="absolute inset-0 section-gradient" />
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[600px] rounded-full bg-primary/5 blur-3xl pointer-events-none" />

      <div className="container mx-auto px-6 relative z-10">
        {/* Section header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <h2 className="text-3xl md:text-5xl font-display font-bold text-foreground leading-[1.1] lowercase mb-4">
            <span className="normal-case">People</span> who{' '}
            <span className="gradient-text">get it</span>
          </h2>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
            A community that shows up for Shabbat dinners, study sessions,
            gatherings, business deals and everything in between.
          </p>
        </motion.div>

        {/* Stats grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
          {stats.map((stat) => (
            <motion.div
              key={stat.label}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: stat.delay }}
              className="relative group"
            >
              <div className="gradient-border rounded-2xl p-6 text-center transition-all duration-300 group-hover:scale-[1.03] h-full flex flex-col items-center justify-center">
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-primary/10 mb-4">
                  <stat.icon className="w-6 h-6 text-primary" />
                </div>
                <div className={`${stat.valueClass} font-display font-bold text-foreground mb-1`}>
                  {stat.value}
                </div>
                <div className="text-sm text-muted-foreground font-medium">
                  {stat.label}
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default SocialProofSection;
