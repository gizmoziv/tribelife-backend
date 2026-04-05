import { motion } from "framer-motion";
import { ShieldCheck, EyeOff, Lock } from "lucide-react";

const commitments = [
  {
    icon: EyeOff,
    text: "We never sell your data",
  },
  {
    icon: Lock,
    text: "Conversations stay private",
  },
  {
    icon: ShieldCheck,
    text: "Every beacon is moderated",
  },
];

const PrivacyCallout = () => {
  return (
    <motion.section
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.5 }}
      className="py-10 md:py-14"
    >
      <div className="container mx-auto px-6">
        <div className="gradient-border rounded-2xl p-6 md:p-8">
          <div className="flex flex-col md:flex-row items-center justify-center gap-6 md:gap-12">
            {commitments.map((item) => (
              <div
                key={item.text}
                className="flex items-center gap-3"
              >
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <item.icon className="w-5 h-5 text-primary" />
                </div>
                <span className="text-sm md:text-base font-medium text-foreground">
                  {item.text}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </motion.section>
  );
};

export default PrivacyCallout;
