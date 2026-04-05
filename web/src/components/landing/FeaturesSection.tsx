import { motion } from "framer-motion";
import { Flame, MapPin, Users, Shield, Zap, Heart } from "lucide-react";

const features = [
  {
    icon: Flame,
    title: "Beacon Matching",
    description: "Post what you need: a Shabbat dinner host, a study partner, a moving helper. TribeLife matches you daily with the right person.",
  },
  {
    icon: MapPin,
    title: "Timezone-Based Community",
    description: "Connected to people who are actually awake when you are. Our timezone is our community. No more 3am replies.",
  },
  {
    icon: Users,
    title: "Built to Show Up",
    description: "No vanity metrics, no infinite scrolling. Every feature is designed around one thing: people showing up for each other.",
  },
  {
    icon: Shield,
    title: "Real People Only",
    description: "Real profiles, real people. Our verification system keeps the community genuine, because trust is everything.",
  },
  {
    icon: Zap,
    title: "Intelligent Matching",
    description: "Every day at 6am, our matching engine connects people with shared needs and interests. Wake up to our people.",
  },
  {
    icon: Heart,
    title: "If You Know, You Know",
    description: "TribeLife is for people who believe in community as a way of life, not just an app feature.",
  },
];

const cardVariants = {
  hidden: { opacity: 0, y: 30 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, delay: i * 0.1 },
  }),
};

const FeaturesSection = () => {
  return (
    <section id="features" aria-label="Features" className="py-24 md:py-32 section-gradient">
      <div className="container mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <h2 className="text-3xl md:text-5xl font-bold mb-4">
            Why <span className="gradient-text">TribeLife</span>?
          </h2>
          <p className="text-muted-foreground text-lg max-w-xl mx-auto">
            Built for people who show up for each other. No noise. Just our community.
          </p>
        </motion.div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((feature, i) => (
            <motion.div
              key={feature.title}
              custom={i}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
              variants={cardVariants}
              className="gradient-border rounded-2xl p-7 hover:scale-[1.02] transition-transform"
            >
              <div className="gradient-bg w-12 h-12 rounded-xl flex items-center justify-center mb-5">
                <feature.icon className="w-6 h-6 text-primary-foreground" />
              </div>
              <h3 className="text-xl font-bold mb-2">{feature.title}</h3>
              <p className="text-muted-foreground leading-relaxed text-sm">{feature.description}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default FeaturesSection;
