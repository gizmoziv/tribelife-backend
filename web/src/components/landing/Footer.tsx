import { Link } from 'react-router-dom';
import logo from '@/assets/tribelife-logo.png';
import { trackDownloadClick } from '@/lib/analytics';

const APP_STORE_URL = 'https://apps.apple.com/us/app/tribelife-app/id6759845843';
const PLAY_STORE_URL = ''; // TODO: replace with Play Store URL when Android app is published

function getDownloadUrl() {
  if (PLAY_STORE_URL && /android/i.test(navigator.userAgent)) return PLAY_STORE_URL;
  return APP_STORE_URL;
}

function getDownloadPlatform(): 'ios' | 'android' {
  return /android/i.test(navigator.userAgent) ? 'android' : 'ios';
}

const Footer = () => {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="border-t border-border py-12">
      <div className="container mx-auto px-6">
        <div className="flex flex-col md:flex-row items-center justify-between gap-8">
          <div className="flex flex-col items-center md:items-start gap-3">
            <img src={logo} alt="TribeLife" className="h-7" />
            <p className="text-sm text-muted-foreground">
              Real users. Real community. Real value.
            </p>
          </div>

          <div className="flex items-center gap-6 text-sm text-muted-foreground">
            <Link
              to="/terms"
              className="hover:text-foreground transition-colors"
            >
              Terms of Service
            </Link>
            <Link
              to="/privacy"
              className="hover:text-foreground transition-colors"
            >
              Privacy Policy
            </Link>
            <a
              href={getDownloadUrl()}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackDownloadClick(getDownloadPlatform(), 'footer')}
              className="hover:text-foreground transition-colors"
            >
              Download
            </a>
            <Link
              to="/support"
              className="hover:text-foreground transition-colors"
            >
              Support
            </Link>
          </div>
        </div>

        <div className="mt-8 pt-8 border-t border-border text-center text-xs text-muted-foreground">
          © {currentYear} TribeLife™ by UBot Labs. All rights reserved.
        </div>
      </div>
    </footer>
  );
};

export default Footer;
