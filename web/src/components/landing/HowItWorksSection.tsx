import { motion } from 'framer-motion';

const steps = [
  {
    number: '01',
    title: 'Join Your Chevra',
    description:
      "Download TribeLife and create your profile in seconds. Your timezone places you in a community of people who are actually around when you are.",
  },
  {
    number: '02',
    title: 'Post a Beacon',
    description:
      'Looking for a Shabbat dinner host in a new city? Need a study partner or someone to volunteer with? Post it — your community is listening.',
  },
  {
    number: '03',
    title: 'Find Your People',
    description:
      "Every morning, TribeLife matches your beacon with others in your timezone. Wake up to real connections — zero noise, zero swiping.",
  },
];

const HowItWorksSection = () => {
  return (
    <section
      id="how-it-works"
      aria-label="How It Works"
      className="py-24 md:py-12"
    >
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
            Three simple steps to find your chevra.
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
              <span className="gradient-text text-6xl font-bold">
                {step.number}
              </span>
              <h3 className="text-xl font-bold mt-4 mb-3">{step.title}</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">
                {step.description}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default HowItWorksSection;
