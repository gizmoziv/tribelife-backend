import { motion } from 'framer-motion';
import { Users, Heart, MapPin, Star } from 'lucide-react';

const stats = [
  { icon: Users, value: '5K+', label: 'Active Members', delay: 0 },
  { icon: Heart, value: '12K+', label: 'Matches Made', delay: 0.1 },
  { icon: MapPin, value: '120+', label: 'Cities Worldwide', delay: 0.2 },
  { icon: Star, value: '5.0', label: 'Average Rating', delay: 0.3 },
];

const testimonials = [
  {
    quote:
      'TribeLife helped me find my people in a new city. Within weeks I had a tight-knit group that feels like family.',
    name: 'Amara J.',
    role: 'Community Member',
    location: 'Atlanta, GA',
  },
  {
    quote:
      'I was tired of surface-level connections. TribeLife matched me with people who actually share my values and energy.',
    name: 'David R.',
    role: 'Early Adopter',
    location: 'Toronto, CA',
  },
  {
    quote:
      "The community events are incredible. I've built friendships here that I know will last a lifetime.",
    name: 'Priya S.',
    role: 'Community Leader',
    location: 'London, UK',
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
            Trusted by Thousands
          </span>
          <h2 className="text-3xl md:text-5xl font-display font-bold text-foreground mb-4">
            Real People. Real{' '}
            <span className="gradient-text">Connections.</span>
          </h2>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
            Join a thriving community that's redefining how people connect,
            grow, and belong.
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
              <div className="gradient-border rounded-2xl p-6 text-center transition-all duration-300 group-hover:scale-[1.03]">
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
        {/* <div className="grid md:grid-cols-3 gap-6">
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

                <div className="flex gap-1 mb-4">
                  {Array.from({ length: 5 }).map((_, j) => (
                    <Star
                      key={j}
                      className="w-4 h-4 fill-primary text-primary"
                    />
                  ))}
                </div>

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
        </div> */}
      </div>
    </section>
  );
};

export default SocialProofSection;
