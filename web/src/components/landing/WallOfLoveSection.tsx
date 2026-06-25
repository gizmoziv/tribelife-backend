import { motion } from 'framer-motion';
import Brand from './Brand';

type Platform = 'linkedin' | 'whatsapp';

interface Clip {
  src: string;
  platform: Platform;
  alt: string;
}

// Authentic message clips lifted from real LinkedIn & WhatsApp conversations
// (names + faces removed). Interleaved so the wall reads as an organic montage.
const clips: Clip[] = [
  { src: '/social-proof/linkedin-01.png', platform: 'linkedin', alt: 'LinkedIn message: “Wow, that sounds awesome”' },
  { src: '/social-proof/whatsapp-01.png', platform: 'whatsapp', alt: 'WhatsApp message: “Hey very cool! Thanks for including me. Will definitely be joining the tribe 😇”' },
  { src: '/social-proof/linkedin-04.png', platform: 'linkedin', alt: 'LinkedIn message: “That is a beautiful idea. This is perhaps needed more now than ever before. Will check it out. Thanks.”' },
  { src: '/social-proof/whatsapp-05.png', platform: 'whatsapp', alt: 'WhatsApp message: “Sure I’ll have a look at it thanks for sending it over”' },
  { src: '/social-proof/linkedin-03.png', platform: 'linkedin', alt: 'LinkedIn message: “Downloaded the app and posted!”' },
  { src: '/social-proof/whatsapp-02.png', platform: 'whatsapp', alt: 'WhatsApp message: “Downloaded and looking forward to exploring! Thanks so much for the link and suggestion.”' },
  { src: '/social-proof/linkedin-05.png', platform: 'linkedin', alt: 'LinkedIn message: “Hi! This looks very cool happy to check it out. Thank you!”' },
  { src: '/social-proof/whatsapp-03.png', platform: 'whatsapp', alt: 'WhatsApp message: “Hi, Thank you! I appreciate the share, I’ll definitely check it out.”' },
  { src: '/social-proof/linkedin-07.png', platform: 'linkedin', alt: 'LinkedIn message: “Loading on my phone as we speak 😊”' },
  { src: '/social-proof/whatsapp-06.png', platform: 'whatsapp', alt: 'WhatsApp message: “Yeah — that may be relevant for my business.. I’ll check this app. Thank you!”' },
  { src: '/social-proof/linkedin-06.png', platform: 'linkedin', alt: 'LinkedIn message: “Thank you! Will check the app!”' },
  { src: '/social-proof/whatsapp-07.png', platform: 'whatsapp', alt: 'WhatsApp messages: “Beautiful! I am about to download and take it for a spin” and “Appreciate you sharing”' },
  { src: '/social-proof/linkedin-02.png', platform: 'linkedin', alt: 'LinkedIn message: “Hi, It looks interesting. I wonder if there might be a good audience there for my latest book 📕”' },
  { src: '/social-proof/whatsapp-04.png', platform: 'whatsapp', alt: 'WhatsApp message: “Hi, thanks for getting in touch. Sure, I will have a look at it gladly.”' },
  { src: '/social-proof/whatsapp-08.png', platform: 'whatsapp', alt: 'WhatsApp message: “Very cool. Just checked it out”' },
];

// A real screenshot clip, framed with a warm brand-gradient border. The
// screenshots already carry each platform's native UI, so no badge is needed.
const ClipFrame = ({ clip }: { clip: Clip }) => (
  <div className="group relative rounded-2xl p-px bg-foreground/20 shadow-md transition-all duration-300 hover:-translate-y-1 hover:shadow-xl">
    <div className="overflow-hidden rounded-[14px] bg-white">
      <img
        src={clip.src}
        alt={clip.alt}
        loading="lazy"
        decoding="async"
        className="block w-full h-auto"
      />
    </div>
  </div>
);

const WallOfLoveSection = () => {
  return (
    <section className="relative py-24 overflow-hidden">
      {/* Background accent */}
      <div className="absolute inset-0 section-gradient" />
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[600px] rounded-full bg-primary/5 blur-3xl pointer-events-none" />

      <div className="container mx-auto px-6 relative z-10">
        {/* Wall of Love */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center mb-12"
        >
          {/* <span className="text-sm font-semibold uppercase tracking-widest text-secondary mb-3 block">
            Loved across every platform
          </span> */}
          <h2 className="text-3xl md:text-5xl font-display font-bold text-foreground leading-[1.1] lowercase">
            <span className="normal-case">It&apos;s</span> as if platforms got together
            <br className="hidden sm:block" />{' '}
            to make a <span className="gradient-text">Jewish baby</span> 😇
          </h2>
        </motion.div>

        {/* Featured clip — the authentic message that inspired the headline */}
        <motion.figure
          initial={{ opacity: 0, scale: 0.96, y: 24 }}
          whileInView={{ opacity: 1, scale: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="relative mx-auto max-w-xl mb-14"
        >
          <div className="absolute -inset-x-8 -inset-y-6 bg-primary/10 blur-3xl rounded-[3rem] pointer-events-none" />
          <div className="group relative rounded-3xl p-[3px] gradient-bg glow-shadow">
            <div className="overflow-hidden rounded-[21px] bg-white">
              <img
                src="/social-proof/whatsapp-feature.png"
                alt='WhatsApp message: “Really great idea. Like Whatsapp and LinkedIn had a Jewish baby 😂”'
                loading="lazy"
                decoding="async"
                className="block w-full h-auto"
              />
            </div>
          </div>
          <figcaption className="mt-4 text-center text-sm text-muted-foreground">
            Actual messages from <Brand /> members.
          </figcaption>
        </motion.figure>

        {/* The wall — organic masonry montage of real clips */}
        <div className="columns-1 sm:columns-2 lg:columns-3 gap-5 [column-fill:_balance]">
          {clips.map((clip, i) => (
            <motion.figure
              key={clip.src}
              initial={{ opacity: 0, y: 28 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-40px' }}
              transition={{
                duration: 0.5,
                delay: Math.min(i * 0.06, 0.5),
                ease: [0.16, 1, 0.3, 1],
              }}
              className="break-inside-avoid mb-5 mx-auto max-w-[400px] sm:max-w-none"
            >
              <ClipFrame clip={clip} />
            </motion.figure>
          ))}
        </div>

        {/* Trademark / non-affiliation notice */}
        <p className="mt-12 mx-auto max-w-2xl text-center text-xs leading-relaxed text-muted-foreground/70">
          Real messages from <Brand /> members, shared anonymously with names and
          faces removed. <Brand /> is an independent app and is not affiliated
          with, sponsored by, or endorsed by LinkedIn, WhatsApp, or Meta. All
          product names, logos, and trademarks are the property of their
          respective owners.
        </p>
      </div>
    </section>
  );
};

export default WallOfLoveSection;
