import { motion } from "framer-motion";
import { Heart } from "lucide-react";

const FoundersNote = () => {
  return (
    <section className="py-20 md:py-28">
      <div className="container mx-auto px-6 max-w-3xl">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-8"
        >
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-primary/10 mb-4">
            <Heart className="w-6 h-6 text-primary" />
          </div>
          <h2 className="text-3xl md:text-4xl font-display font-bold text-foreground">
            Why We Built <span className="gradient-text">TribeLife</span>
          </h2>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.15 }}
          className="gradient-border rounded-2xl p-8 md:p-10"
        >
          <div className="space-y-5 text-muted-foreground leading-relaxed text-base md:text-lg">
            <p>
              Our team has spent years in the Jewish social network space. We've
              seen communities that offer breadth but lack depth, and private ones
              that go deeper but still leave people spraying and praying for the
              right connection. Neither works the way it should.
            </p>
            <p>
              For thousands of years, shuls were where intentional matches
              happened. Someone knew what you needed and connected you with the
              right person. TribeLife brings that same spirit online. Post what
              you need, and let our community lift you up.
            </p>
            <p>
              TribeLife is free. One beacon, every day, at no cost. Need more?
              Upgrade for a few dollars a month, or help us{" "}
              <a
                href="https://apps.apple.com/us/app/tribelife-app/id6759845843"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline font-medium"
              >
                spread the word
              </a>{" "}
              to unlock additional beacons.
            </p>
            <p className="text-foreground font-medium">
              Believe in what we're building?{" "}
              <a
                href="https://buymeacoffee.com/ubotlabs"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                Support our mission
              </a>{" "}
              or{" "}
              <a
                href="mailto:info@tribelife.app"
                className="text-primary hover:underline"
              >
                reach out
              </a>{" "}
              to join our team.
            </p>
          </div>
        </motion.div>
      </div>
    </section>
  );
};

export default FoundersNote;
