import { useEffect } from 'react';
import { Helmet } from 'react-helmet-async';
import Navbar from '@/components/landing/Navbar';
import HeroSection from '@/components/landing/HeroSection';
import AppShowcaseSection from '@/components/landing/AppShowcaseSection';
import FeaturesSection from '@/components/landing/FeaturesSection';
import PrivacyCallout from '@/components/landing/PrivacyCallout';
import SocialProofSection from '@/components/landing/SocialProofSection';
import HowItWorksSection from '@/components/landing/HowItWorksSection';
import FAQSection from '@/components/landing/FAQSection';
import FoundersNote from '@/components/landing/FoundersNote';
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
          TribeLife — Meet Real People in Your Community | Local Matching App
        </title>
        <meta
          name="description"
          content="TribeLife connects you with real people nearby. Create beacons for what you need and get intelligent matches in our community."
        />
        <link rel="canonical" href="https://tribelife.app/" />
      </Helmet>
      <Navbar />
      <HeroSection />
      <AppShowcaseSection />
      <FeaturesSection />
      <PrivacyCallout />
      <SocialProofSection />
      <HowItWorksSection />
      <FAQSection />
      <FoundersNote />
      <CTASection />
      <StickyDownloadBar />
      <Footer />
    </div>
  );
};

export default Index;
