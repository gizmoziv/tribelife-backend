import { useState } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown } from 'lucide-react';

const faqs = [
  {
    question: 'Is TribeLife free?',
    answer:
      'Yes! TribeLife is completely free to download and use. You get one beacon per day. If you want more, TribeLife Premium lets you post up to three beacons daily for $4.99/month.',
  },
  {
    question: 'What is a beacon?',
    answer:
      "A beacon is a short post describing what you need — a Shabbat dinner host, a study partner, a moving helper, a pickleball buddy. Every morning at 6am, our AI matches your beacon with people in your timezone who can help.",
  },
  {
    question: 'How does matching work?',
    answer:
      "Every day at 6am your local time, TribeLife's AI engine analyzes all active beacons in your timezone and connects you with the most relevant people. You wake up to real, meaningful matches — no swiping, no endless scrolling.",
  },
  {
    question: 'Is it safe?',
    answer:
      'Safety is a priority. Every user signs in with Google to verify their identity. All beacons are moderated by AI before they go live. We keep your community genuine — real people, real profiles.',
  },
  {
    question: 'Is TribeLife available on Android?',
    answer:
      "We're finalizing the Android launch right now. Join our waitlist and we'll notify you the moment it's live on Google Play.",
  },
];

const FAQItem = ({ question, answer }: { question: string; answer: string }) => {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-b border-border/50 last:border-b-0">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between py-5 text-left gap-4"
      >
        <span className="text-base font-semibold text-foreground">{question}</span>
        <ChevronDown
          className={`w-5 h-5 text-muted-foreground shrink-0 transition-transform duration-200 ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>
      <div
        className={`overflow-hidden transition-all duration-200 ${
          open ? 'max-h-60 pb-5' : 'max-h-0'
        }`}
      >
        <p className="text-muted-foreground text-sm leading-relaxed">{answer}</p>
      </div>
    </div>
  );
};

const FAQSection = () => {
  return (
    <section id="faq" aria-label="Frequently Asked Questions" className="py-24 md:py-32">
      <div className="container mx-auto px-6 max-w-3xl">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-12"
        >
          <h2 className="text-3xl md:text-5xl font-bold mb-4">
            Frequently Asked <span className="gradient-text">Questions</span>
          </h2>
          <p className="text-muted-foreground text-lg">
            Everything you need to know before joining.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="gradient-border rounded-2xl p-6 md:p-8"
        >
          {faqs.map((faq) => (
            <FAQItem key={faq.question} question={faq.question} answer={faq.answer} />
          ))}
        </motion.div>
      </div>
    </section>
  );
};

export default FAQSection;
