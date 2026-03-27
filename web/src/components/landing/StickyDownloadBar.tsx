import { useState, useEffect } from 'react';
import { Apple, Play } from 'lucide-react';
import { trackDownloadClick } from '@/lib/analytics';

const APP_STORE_URL = 'https://apps.apple.com/us/app/tribelife-app/id6759845843';
const ANDROID_URL = 'https://play.google.com/store/apps/details?id=com.tribelife.app';

const StickyDownloadBar = () => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setVisible(window.scrollY > window.innerHeight * 0.8);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const isAndroid = /android/i.test(navigator.userAgent);

  return (
    <div
      className={`fixed bottom-0 left-0 right-0 z-50 md:hidden transition-transform duration-300 ${
        visible ? 'translate-y-0' : 'translate-y-full'
      }`}
    >
      <div className="bg-background/95 backdrop-blur-xl border-t border-border/50 px-4 py-3 flex gap-3">
        <a
          href={isAndroid ? ANDROID_URL : APP_STORE_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => trackDownloadClick(isAndroid ? 'android' : 'ios', 'hero_bottom')}
          className="gradient-bg gradient-bg-hover text-primary-foreground flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-semibold text-sm transition-all flex-1"
        >
          {isAndroid ? (
            <>
              <Play className="w-4 h-4" />
              Download on Google Play
            </>
          ) : (
            <>
              <Apple className="w-4 h-4" />
              Download for iOS — Free
            </>
          )}
        </a>
      </div>
    </div>
  );
};

export default StickyDownloadBar;
