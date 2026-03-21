import { motion } from 'framer-motion';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import logo from '@/assets/tribelife-logo.png';
import ThemeToggle from './ThemeToggle';
import { trackDownloadClick, trackNavClick } from '@/lib/analytics';

const APP_STORE_URL = 'https://apps.apple.com/us/app/tribelife-app/id6759845843';
const PLAY_STORE_URL = ''; // TODO: replace with Play Store URL when Android app is published

function getDownloadUrl() {
  if (PLAY_STORE_URL && /android/i.test(navigator.userAgent)) return PLAY_STORE_URL;
  return APP_STORE_URL;
}

function getDownloadPlatform(): 'ios' | 'android' {
  return /android/i.test(navigator.userAgent) ? 'android' : 'ios';
}

const Navbar = () => {
  const location = useLocation();
  const navigate = useNavigate();

  function handleSectionNav(e: React.MouseEvent, section: string) {
    e.preventDefault();
    trackNavClick(section);
    if (location.pathname === '/') {
      document.getElementById(section)?.scrollIntoView({ behavior: 'smooth' });
    } else {
      navigate(`/#${section}`);
    }
  }

  return (
    <motion.nav
      initial={{ y: -20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.5 }}
      className="fixed top-0 left-0 right-0 z-50 backdrop-blur-xl bg-background/70 border-b border-border/50"
    >
      <div className="container mx-auto px-6 py-4 flex items-center justify-between">
        <a href="/" className="flex items-center gap-2">
          <img
            src={logo}
            alt="TribeLife - Local Community Matching App"
            className="h-20"
          />
        </a>

        <div className="hidden md:flex items-center gap-8 text-sm font-medium text-muted-foreground">
          <a href="#features" onClick={(e) => handleSectionNav(e, 'features')} className="hover:text-foreground transition-colors">
            Features
          </a>
          <a href="#how-it-works" onClick={(e) => handleSectionNav(e, 'how-it-works')} className="hover:text-foreground transition-colors">
            How It Works
          </a>
          <a href="#community" onClick={(e) => handleSectionNav(e, 'community')} className="hover:text-foreground transition-colors">
            Community
          </a>
          <Link to="/support" className="hover:text-foreground transition-colors">
            Support
          </Link>
        </div>

        <div className="flex items-center gap-3">
          <ThemeToggle />
          <a
            href={getDownloadUrl()}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => trackDownloadClick(getDownloadPlatform(), 'header')}
            className="gradient-bg gradient-bg-hover text-primary-foreground px-5 py-2.5 rounded-full text-sm font-semibold transition-all glow-shadow hover:scale-105"
          >
            Download App
          </a>
        </div>
      </div>
    </motion.nav>
  );
};

export default Navbar;
