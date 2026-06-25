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
          <h2 className="text-3xl md:text-5xl font-display font-bold text-foreground leading-[1.1] lowercase mb-4">
            <span className="normal-case">See</span>{' '}
            <span className="gradient-text font-extrabold tracking-tight lowercase">tribelife</span>{' '}
            in Action
          </h2>
          <p className="text-lg text-muted-foreground max-w-xl mx-auto">
            Fun. Valuable. One app built intentionally for our community.
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
              {/* Modern dark phone case */}
              <div className="relative rounded-[2.75rem] bg-gradient-to-br from-zinc-600 via-zinc-900 to-zinc-950 p-2 shadow-2xl shadow-black/50 ring-1 ring-white/10 group-hover:shadow-black/60 transition-shadow duration-500">
                {/* Side buttons (volume + power) */}
                <span aria-hidden className="absolute -left-[3px] top-[17%] h-[7%] w-[3px] rounded-l-sm bg-zinc-800" />
                <span aria-hidden className="absolute -left-[3px] top-[26%] h-[7%] w-[3px] rounded-l-sm bg-zinc-800" />
                <span aria-hidden className="absolute -right-[3px] top-[22%] h-[12%] w-[3px] rounded-r-sm bg-zinc-800" />
                {/* Screen — rounded corners clip the screenshot */}
                <div className="rounded-[2.25rem] overflow-hidden bg-black ring-1 ring-inset ring-black/60">
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
