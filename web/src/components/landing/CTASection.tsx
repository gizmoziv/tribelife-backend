import { motion } from "framer-motion";
import { AppStoreBadge, GooglePlayBadge } from './StoreBadge';
import { trackDownloadClick } from "@/lib/analytics";

const APP_STORE_URL = "https://apps.apple.com/us/app/tribelife-app/id6759845843";
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.tribelife.app';

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
              Your chevra is already here. Come find them.
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <AppStoreBadge
                href={APP_STORE_URL}
                onClick={() => trackDownloadClick('ios', 'cta_bottom')}
              />
              <GooglePlayBadge
                href={PLAY_STORE_URL}
                onClick={() => trackDownloadClick('android', 'cta_bottom')}
              />
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
};

export default CTASection;
