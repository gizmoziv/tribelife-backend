import { useEffect } from 'react';
import { Helmet } from 'react-helmet-async';
import Navbar from '@/components/landing/Navbar';
import HeroSection from '@/components/landing/HeroSection';
import AppShowcaseSection from '@/components/landing/AppShowcaseSection';
import FeaturesSection from '@/components/landing/FeaturesSection';
import PrivacyCallout from '@/components/landing/PrivacyCallout';
import SocialProofSection from '@/components/landing/SocialProofSection';
import WallOfLoveSection from '@/components/landing/WallOfLoveSection';
import HowItWorksSection from '@/components/landing/HowItWorksSection';
import FAQSection from '@/components/landing/FAQSection';
import FoundersNote from '@/components/landing/FoundersNote';
import CohortSection from '@/components/landing/CohortSection';
import CTASection from '@/components/landing/CTASection';
import StickyDownloadBar from '@/components/landing/StickyDownloadBar';
import Footer from '@/components/landing/Footer';

const Index = () => {
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash) {
      document.getElementById(hash)?.scrollIntoView({ behavior: 'smooth' });
    }
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>
          TribeLife: A Private, Vetted Network for Jewish Professionals
        </title>
        <meta
          name="description"
          content="TribeLife is a private, vetted network for the Jewish community. You join by referral from a member, or via review from a team member. Post a beacon for what you need and get matched with Jewish professionals who can actually help."
        />
        <link rel="canonical" href="https://tribelife.app/" />
      </Helmet>
      <Navbar />
      <HeroSection />
      <FeaturesSection />
      <WallOfLoveSection />
      <AppShowcaseSection />
      <HowItWorksSection />
      <FoundersNote />
      <CohortSection />
      <SocialProofSection />
      <FAQSection />
      <PrivacyCallout />
      <CTASection />
      <StickyDownloadBar />
      <Footer />
    </div>
  );
};

export default Index;
