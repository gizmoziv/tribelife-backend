import { motion } from 'framer-motion';
import { Users, Heart, MapPin, Star } from 'lucide-react';

const stats = [
  { icon: Users, value: '5K+', label: 'Active Members', delay: 0 },
  { icon: Heart, value: 'Growing Daily', label: 'Matches Made', delay: 0.1 },
  { icon: MapPin, value: '24', label: 'Timezones', delay: 0.2 },
  { icon: Star, value: '5 ★', label: 'App Store Rating', delay: 0.3 },
];

const testimonials = [
  {
    quote:
      'I moved to a new city and didn\'t know a soul. Within two weeks TribeLife had me at a Shabbat dinner with people who felt like old friends.',
    name: 'Maya L.',
    role: 'Member',
    location: 'Miami, FL',
  },
  {
    quote:
      'Finally an app that gets it. I posted a beacon looking for a study partner and found three people in my timezone who were exactly what I needed.',
    name: 'Jacob S.',
    role: 'Early Member',
    location: 'New York, NY',
  },
  {
    quote:
      "I've tried every community app. This one's different. You can just feel it — the people here actually show up for each other.",
    name: 'Noa R.',
    role: 'Member',
    location: 'Tel Aviv, IL',
  },
];

const SocialProofSection = () => {
  return (
    <section className="relative py-24 overflow-hidden">
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
          <span className="text-sm font-semibold uppercase tracking-widest text-primary mb-3 block">
            People Who Get It
          </span>
          <h2 className="text-3xl md:text-5xl font-display font-bold text-foreground mb-4">
            Real People. Real{' '}
            <span className="gradient-text">Chevra.</span>
          </h2>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
            A community that shows up for Shabbat dinners, study sessions,
            gatherings, business deals and everything in between.
          </p>
        </motion.div>

        {/* Stats grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-20">
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
                <div className="text-3xl md:text-4xl font-display font-bold text-foreground mb-1">
                  {stat.value}
                </div>
                <div className="text-sm text-muted-foreground font-medium">
                  {stat.label}
                </div>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Testimonials */}
        <motion.h3
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-2xl md:text-3xl font-bold text-center mb-8"
        >
          Hear From Our Users
        </motion.h3>
        <div className="grid md:grid-cols-3 gap-6">
          {testimonials.map((t, i) => (
            <motion.div
              key={t.name}
              initial={{ opacity: 0, y: 28 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: i * 0.12 }}
              className="relative group"
            >
              <div className="gradient-border rounded-2xl p-8 h-full flex flex-col transition-all duration-300 group-hover:scale-[1.02]">
                <blockquote className="text-foreground/90 text-base leading-relaxed mb-6 flex-1">
                  "{t.quote}"
                </blockquote>
                <div className="border-t border-border/50 pt-4">
                  <p className="font-semibold text-foreground">{t.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {t.role} · {t.location}
                  </p>
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
