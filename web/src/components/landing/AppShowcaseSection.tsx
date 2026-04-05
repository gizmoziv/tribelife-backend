import { motion } from "framer-motion";

const screenshots = [
  {
    src: "/screenshots/chat.png",
    alt: "TribeLife community chat — warm Passover greetings and friendly conversation",
    label: "Connect",
    description: "Join vibrant conversations with our community",
  },
  {
    src: "/screenshots/beacon-setup.png",
    alt: "Setting up a beacon on TribeLife — describe what you need in one sentence",
    label: "Post a Beacon",
    description: "Tell us what you need in one simple sentence",
  },
  {
    src: "/screenshots/beacon-matches.png",
    alt: "Beacon matches on TribeLife — matched with people who share your interests",
    label: "Get Matched",
    description: "Wake up to real, meaningful matches nearby",
  },
];

const AppShowcaseSection = () => {
  return (
    <section className="py-20 md:py-28 bg-background overflow-hidden">
      <div className="container mx-auto px-4">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <h2 className="text-3xl md:text-4xl font-display font-bold text-foreground mb-4">
            See TribeLife in Action
          </h2>
          <p className="text-lg text-muted-foreground max-w-xl mx-auto">
            Fun. Valuable. An app built for real connection within our community.
          </p>
        </motion.div>

        <div className="flex flex-col md:flex-row items-center justify-center gap-8 md:gap-12 lg:gap-16">
          {screenshots.map((screen, i) => (
            <motion.div
              key={screen.label}
              initial={{ opacity: 0, y: 40 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }}
              transition={{ duration: 0.6, delay: i * 0.15 }}
              className="flex flex-col items-center group"
            >
              {/* Phone frame with gradient border */}
              <div className="relative p-[3px] rounded-[2.5rem] bg-gradient-to-br from-orange-400 via-pink-500 to-purple-600 shadow-2xl shadow-purple-500/20 group-hover:shadow-purple-500/30 transition-shadow duration-500">
                {/* Inner container with rounded corners to clip the image */}
                <div className="rounded-[2.3rem] overflow-hidden bg-background">
                  <img
                    src={screen.src}
                    alt={screen.alt}
                    className="w-[240px] md:w-[260px] lg:w-[280px] h-auto block"
                    loading="lazy"
                  />
                </div>
              </div>

              {/* Label and description */}
              <div className="mt-6 text-center max-w-[260px]">
                <span className="inline-block px-3 py-1 rounded-full text-xs font-semibold tracking-wide uppercase bg-gradient-to-r from-orange-400 to-purple-500 text-white mb-2">
                  {screen.label}
                </span>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {screen.description}
                </p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default AppShowcaseSection;
