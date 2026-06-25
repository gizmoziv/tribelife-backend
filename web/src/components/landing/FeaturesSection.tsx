import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { Flame } from "lucide-react";

const perks: ReactNode[] = [
  "The whole chat history is here, even if you show up late",
  "Auto-translation, Hebrew included — come as you are",
  "Local + global rooms by default, no caps on # of members",
  "Your own DMs and group chats, no gatekeepers",
  <>
    One beacon hunts networks for you every night, FREE.
    <br />
    <span className="font-semibold text-foreground">
      Want more beacons? Premium is just $5, or a cup of joe.
    </span>
  </>,
];

const listVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.1 } },
};

const itemVariants = {
  hidden: { opacity: 0, x: -16 },
  visible: { opacity: 1, x: 0, transition: { duration: 0.5 } },
};

const FeaturesSection = () => {
  return (
    <section id="features" aria-label="Why TribeLife" className="py-24 md:py-32 section-gradient">
      <div className="container mx-auto px-6">
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={listVariants}
          className="max-w-xl mx-auto"
        >
          <motion.h2
            variants={itemVariants}
            className="text-3xl md:text-5xl font-display font-bold text-foreground leading-[1.1] mb-12 text-center text-balance"
          >
            Why is this app different{" "}
            <span className="gradient-text">from all others?</span>
          </motion.h2>

          <ul className="space-y-7">
            {perks.map((perk, i) => (
              <motion.li
                key={i}
                variants={itemVariants}
                className="flex items-start gap-4"
              >
                <span className="shrink-0 mt-0.5 text-xl leading-none" aria-hidden="true">
                  <Flame className="w-6 h-6 text-primary" />
                </span>
                <span className="text-muted-foreground text-[17px] md:text-[19px] leading-relaxed">
                  {perk}
                </span>
              </motion.li>
            ))}
          </ul>

          <motion.div variants={itemVariants} className="mt-12 flex justify-center">
            <a
              href="#download"
              className="gradient-bg text-primary-foreground font-bold text-lg px-12 py-4 rounded-full shadow-lg hover:scale-[1.03] hover:glow-shadow transition-all"
            >
              Yalla, let&apos;s go 🤙
            </a>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
};

export default FeaturesSection;
