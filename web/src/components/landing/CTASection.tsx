import { motion } from "framer-motion";
import { Apple, Play } from "lucide-react";
import { trackDownloadClick } from "@/lib/analytics";

const APP_STORE_URL = "https://apps.apple.com/us/app/tribelife-app/id6759845843";
const PLAY_STORE_URL = "https://apps.apple.com/us/app/tribelife-app/id6759845843";

const CTASection = () => {
  return (
    <section id="community" aria-label="Download TribeLife" className="py-24 md:py-32 section-gradient">
      <div className="container mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="relative max-w-3xl mx-auto text-center gradient-border rounded-3xl p-12 md:p-16 overflow-hidden"
        >
          {/* Glow */}
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-96 h-48 bg-primary/15 blur-3xl rounded-full" />
          
          <div className="relative z-10">
            <h2 className="text-3xl md:text-5xl font-bold mb-4">
              Ready to Find Your <span className="gradient-text">Tribe</span>?
            </h2>
            <p className="text-muted-foreground text-lg mb-10 max-w-lg mx-auto">
              Join thousands of people building real connections in their communities. Download TribeLife today.
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <a
                href={APP_STORE_URL}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => trackDownloadClick('ios', 'cta_bottom')}
                className="gradient-bg gradient-bg-hover text-primary-foreground flex items-center gap-3 px-7 py-4 rounded-2xl font-semibold transition-all glow-shadow hover:scale-105 w-full sm:w-auto justify-center"
              >
                <Apple className="w-5 h-5" />
                App Store
              </a>
              <a
                href={PLAY_STORE_URL}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => trackDownloadClick('android', 'cta_bottom')}
                className="bg-card border border-border text-foreground flex items-center gap-3 px-7 py-4 rounded-2xl font-semibold transition-all hover:bg-muted hover:scale-105 w-full sm:w-auto justify-center"
              >
                <Play className="w-5 h-5" />
                Google Play
              </a>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
};

export default CTASection;
