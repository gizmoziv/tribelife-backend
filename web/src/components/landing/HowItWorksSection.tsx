import { motion } from "framer-motion";

const steps = [
  {
    number: "01",
    title: "Download & Join",
    description: "Get TribeLife on iOS or Android and create your profile in seconds. Tell us about your interests and what you're looking for.",
  },
  {
    number: "02",
    title: "Create a Beacon",
    description: "Need a pickleball partner? Looking for a babysitter? Post a beacon and describe exactly what you need from your community.",
  },
  {
    number: "03",
    title: "Get Matched",
    description: "TribeLife's intelligent matching engine connects you with the right people nearby. Real connections, zero noise.",
  },
];

const HowItWorksSection = () => {
  return (
    <section id="how-it-works" className="py-24 md:py-32">
      <div className="container mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <h2 className="text-3xl md:text-5xl font-bold mb-4">
            How It <span className="gradient-text">Works</span>
          </h2>
          <p className="text-muted-foreground text-lg max-w-xl mx-auto">
            Three simple steps to unlock your local community.
          </p>
        </motion.div>

        <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
          {steps.map((step, i) => (
            <motion.div
              key={step.number}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: i * 0.15 }}
              className="text-center"
            >
              <span className="gradient-text text-6xl font-bold">{step.number}</span>
              <h3 className="text-xl font-bold mt-4 mb-3">{step.title}</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">{step.description}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default HowItWorksSection;
