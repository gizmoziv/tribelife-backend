import { motion } from "framer-motion";
import { Apple, Play } from "lucide-react";
import heroBg from "@/assets/hero-bg.jpg";
import { trackDownloadClick } from "@/lib/analytics";

const APP_STORE_URL = "https://apps.apple.com/us/app/tribelife-app/id6759845843";
const PLAY_STORE_URL = "https://apps.apple.com/us/app/tribelife-app/id6759845843";

const HeroSection = () => {
  return (
    <section aria-label="Hero" className="relative min-h-screen flex items-center justify-center overflow-hidden pt-20">
      {/* Background */}
      <div className="absolute inset-0">
        <img src={heroBg} alt="People connecting in a local community" className="w-full h-full object-cover opacity-40" />
        <div className="absolute inset-0 bg-gradient-to-b from-background/60 via-background/40 to-background" />
      </div>

      {/* Floating orbs */}
      <div className="absolute top-1/4 left-1/4 w-64 h-64 rounded-full bg-secondary/10 blur-3xl animate-pulse-glow" />
      <div className="absolute bottom-1/3 right-1/4 w-48 h-48 rounded-full bg-primary/10 blur-3xl animate-pulse-glow" style={{ animationDelay: "1.5s" }} />

      <div className="relative z-10 container mx-auto px-6 text-center max-w-4xl">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.2 }}
        >
          <span className="inline-block gradient-bg text-primary-foreground text-xs font-bold uppercase tracking-widest px-4 py-1.5 rounded-full mb-8">
            Now Available on iOS & Android
          </span>
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.35 }}
          className="text-5xl md:text-7xl font-bold leading-tight mb-6"
        >
          Meet Real People in{" "}
          <span className="gradient-text">Your Community</span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.5 }}
          className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto mb-10 leading-relaxed"
        >
          Meet real people near you. Create beacons for what you need — a pickleball partner, 
          a babysitter, a tutor — and let TribeLife's intelligent matching connect you with your community.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.65 }}
          className="flex flex-col sm:flex-row items-center justify-center gap-4"
        >
          <a
            href={APP_STORE_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => trackDownloadClick('ios', 'hero_top')}
            className="gradient-bg gradient-bg-hover text-primary-foreground flex items-center gap-3 px-7 py-4 rounded-2xl font-semibold text-base transition-all glow-shadow hover:scale-105 w-full sm:w-auto justify-center"
          >
            <Apple className="w-5 h-5" />
            Download for iOS
          </a>
          <a
            href={PLAY_STORE_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => trackDownloadClick('android', 'hero_top')}
            className="bg-card border border-border text-foreground flex items-center gap-3 px-7 py-4 rounded-2xl font-semibold text-base transition-all hover:bg-muted hover:scale-105 w-full sm:w-auto justify-center"
          >
            <Play className="w-5 h-5" />
            Download for Android
          </a>
        </motion.div>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.7, delay: 0.9 }}
          className="mt-8 text-sm text-muted-foreground"
        >
          Real users. Real community. Real value.
        </motion.p>
      </div>
    </section>
  );
};

export default HeroSection;
