import Navbar from '@/components/landing/Navbar';
import HeroSection from '@/components/landing/HeroSection';
import FeaturesSection from '@/components/landing/FeaturesSection';
// import SocialProofSection from "@/components/landing/SocialProofSection";
import HowItWorksSection from '@/components/landing/HowItWorksSection';
import CTASection from '@/components/landing/CTASection';
import Footer from '@/components/landing/Footer';

const Index = () => {
  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <HeroSection />
      <FeaturesSection />
      {/* <SocialProofSection /> */}
      <HowItWorksSection />
      <CTASection />
      <Footer />
    </div>
  );
};

export default Index;
