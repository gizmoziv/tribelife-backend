import { useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
import Brand from './Brand';

const faqs = [
  {
    question: (
      <>
        Who is <Brand /> for?
      </>
    ),
    answer: (
      <>
        <Brand /> is a private network for the Jewish community: professionals,
        founders, creators, students, and community leaders, plus the allies who
        show up for us. It&apos;s not a general-purpose social app. It&apos;s the
        room you&apos;d want to walk into: people who get the context without you
        having to explain it.
      </>
    ),
  },
  {
    question: 'How do I get in?',
    answer: (
      <>
        Two ways. Someone already inside refers you, or you apply by telling us
        why you want in and sharing a social profile so we can see you&apos;re a
        real person. A human on our team reviews every application. We know
        that&apos;s more friction than tapping &quot;sign up,&quot; and
        that&apos;s the point.
      </>
    ),
  },
  {
    question: (
      <>
        Is <Brand /> free?
      </>
    ),
    answer: (
      <>
        Yes! <Brand /> is completely free to download and use. You get one
        beacon per day. If you want more, <Brand /> Premium lets you post up to
        three beacons daily for $4.99/month.
      </>
    ),
  },
  {
    question: 'What is a beacon?',
    answer:
      "A beacon is a short post describing what you need: a Shabbat dinner host, a study partner, a moving helper, a pickleball buddy. Every morning at 6am, our AI matches your beacon with people in your timezone who can help.",
  },
  {
    question: 'How does matching work?',
    answer: (
      <>
        Every day at 6am your local time, <Brand />
        &apos;s AI engine analyzes all active beacons in your timezone and
        connects you with the most relevant people. You wake up to real,
        meaningful matches. No swiping, no endless scrolling.
      </>
    ),
  },
  {
    question: 'What security is in place?',
    answer: (
      <>
        Safety is the whole point of the gate. Membership is by referral or
        reviewed application, every member authenticates when they join, and the
        member list is never public or sold. Inside the app, automated
        moderation and human review screen content for harm, and you can report
        or block anyone at any time. More protections are on the way.
      </>
    ),
  },
  {
    question: (
      <>
        How can I support <Brand />?
      </>
    ),
    answer: (
      <>
        <Brand /> is built by a tiny team and free for the community. If
        you&apos;d like to help keep the lights on, you can{' '}
        <a
          href="https://buymeacoffee.com/ubotlabs"
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-primary underline underline-offset-2 hover:opacity-80 transition-opacity"
        >
          buy us a coffee ☕
        </a>
        . Every bit means the world.
      </>
    ),
  },
];

const FAQItem = ({ question, answer }: { question: ReactNode; answer: ReactNode }) => {
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
          <h2 className="text-3xl md:text-5xl font-display font-bold text-foreground leading-[1.1] lowercase mb-4">
            <span className="normal-case">Frequently</span> Asked <span className="gradient-text">Questions</span>
          </h2>
          <p className="text-muted-foreground text-lg">
            Everything you need to know before you apply.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="gradient-border rounded-2xl p-6 md:p-8"
        >
          {faqs.map((faq, i) => (
            <FAQItem key={i} question={faq.question} answer={faq.answer} />
          ))}
        </motion.div>
      </div>
    </section>
  );
};

export default FAQSection;
