import { motion } from "framer-motion";
import { ShieldCheck } from "lucide-react";

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
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 sm:gap-8 max-w-xs sm:max-w-none mx-auto">
            <span className="text-sm md:text-base font-medium text-foreground lowercase text-center sm:flex-1 sm:text-right">
              we never sell your data
            </span>
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
              <ShieldCheck className="w-6 h-6 text-primary" />
            </div>
            <span className="text-sm md:text-base font-medium text-foreground lowercase text-center sm:flex-1 sm:text-left">
              made with cybersecurity
            </span>
          </div>
        </div>
      </div>
    </motion.section>
  );
};

export default PrivacyCallout;
