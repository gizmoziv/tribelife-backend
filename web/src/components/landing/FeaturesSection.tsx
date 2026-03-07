import { motion } from "framer-motion";
import { Flame, MapPin, Users, Shield, Zap, Heart } from "lucide-react";

const features = [
  {
    icon: Flame,
    title: "Beacon Matching",
    description: "Post what you need — a workout buddy, a tutor, a dog walker — and TribeLife's AI finds the perfect match in your area.",
  },
  {
    icon: MapPin,
    title: "Hyperlocal Discovery",
    description: "Connect with people in your neighborhood, not across the globe. Real proximity creates real relationships.",
  },
  {
    icon: Users,
    title: "Community-First Design",
    description: "No vanity metrics, no infinite scrolling. Every interaction is designed to create genuine, lasting value.",
  },
  {
    icon: Shield,
    title: "Verified & Safe",
    description: "Real profiles, real people. Our verification system ensures you're connecting with genuine community members.",
  },
  {
    icon: Zap,
    title: "Intelligent Matching",
    description: "Our smart algorithm learns what matters to you and surfaces the most relevant connections and opportunities.",
  },
  {
    icon: Heart,
    title: "Built for Value",
    description: "No more cookie-cutter social apps that create noise. TribeLife is built to create real value for real people.",
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
            A community app that actually delivers on its promise. No noise, just connections that matter.
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
