import { useState } from 'react';
import { motion } from 'framer-motion';
import { Linkedin } from 'lucide-react';
import Brand from './Brand';

interface Member {
  name: string;
  photo: string;
  linkedin: string;
}

const members: Member[] = [
  { name: 'Sarina', photo: '/cohort/sarina.png', linkedin: 'https://www.linkedin.com/in/sarina-ziv' },
  { name: 'Nir', photo: '/cohort/nir.jpg', linkedin: 'https://www.linkedin.com/in/nirziv' },
  { name: 'Ike', photo: '/cohort/ike.jpg', linkedin: 'https://www.linkedin.com/in/ike-pintchuck' },
  { name: 'Sagie', photo: '/cohort/sagie.png', linkedin: 'https://www.linkedin.com/in/sagie-baram' },
  { name: 'Danya', photo: '/cohort/danya.jpg', linkedin: 'https://www.linkedin.com/in/danya-wasser-075185b4' },
  { name: 'Virginia', photo: '/cohort/virginia.png', linkedin: 'https://www.linkedin.com/in/virginia-weaver' },
  { name: 'Yaacov', photo: '/cohort/yaacov.jpg', linkedin: 'https://www.linkedin.com/in/yaacovsakowitz' },
];

const initials = (name: string) => name.slice(0, 2).toUpperCase();

const MemberAvatar = ({ member }: { member: Member }) => {
  const [imgFailed, setImgFailed] = useState(false);

  return (
    <a
      href={member.linkedin}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${member.name} on LinkedIn`}
      className="group flex flex-col items-center gap-3"
    >
      <div className="relative w-20 h-20 md:w-24 md:h-24 rounded-full p-[3px] gradient-bg transition-transform duration-300 group-hover:scale-105">
        <div className="w-full h-full rounded-full overflow-hidden bg-card ring-2 ring-background">
          {imgFailed ? (
            <div className="w-full h-full flex items-center justify-center gradient-bg text-primary-foreground font-display font-bold text-lg">
              {initials(member.name)}
            </div>
          ) : (
            <img
              src={member.photo}
              alt={member.name}
              loading="lazy"
              decoding="async"
              onError={() => setImgFailed(true)}
              className="w-full h-full object-cover"
            />
          )}
        </div>
        <div className="absolute -bottom-1 -right-1 flex items-center justify-center w-6 h-6 rounded-full bg-[#0A66C2] ring-2 ring-background">
          <Linkedin className="w-3.5 h-3.5 text-white" />
        </div>
      </div>
      <span className="text-sm font-medium text-foreground group-hover:text-primary transition-colors">
        {member.name}
      </span>
    </a>
  );
};

const CohortSection = () => {
  return (
    <section className="py-20 md:py-24">
      <div className="container mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-12"
        >
          <h2 className="text-3xl md:text-5xl font-display font-bold text-foreground leading-[1.1] lowercase mb-4">
            <span className="normal-case">Meet the</span>{' '}
            <span className="gradient-text">cohort</span>
          </h2>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
            The team behind <Brand />'s community.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.1 }}
          className="grid grid-cols-2 gap-x-10 gap-y-10 sm:gap-x-14 max-w-[280px] sm:max-w-xs mx-auto"
        >
          {members.map((member, i) => {
            const isLastOdd = i === members.length - 1 && members.length % 2 === 1;
            return (
              <div key={member.name} className={isLastOdd ? 'col-span-2 flex justify-center' : 'flex justify-center'}>
                <MemberAvatar member={member} />
              </div>
            );
          })}
        </motion.div>
      </div>
    </section>
  );
};

export default CohortSection;
