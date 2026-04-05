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

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isAndroid = /android/i.test(navigator.userAgent);
  const showBoth = !isIOS && !isAndroid;

  return (
    <div
      className={`fixed bottom-0 left-0 right-0 z-50 md:hidden transition-transform duration-300 ${
        visible ? 'translate-y-0' : 'translate-y-full'
      }`}
    >
      <div className="bg-background/95 backdrop-blur-xl border-t border-border/50 px-4 py-3 flex flex-col gap-2">
        {(isIOS || showBoth) && (
          <a
            href={APP_STORE_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => trackDownloadClick('ios', 'hero_bottom')}
            className="gradient-bg gradient-bg-hover text-primary-foreground flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-semibold text-sm transition-all"
          >
            <Apple className="w-4 h-4" />
            Download for iOS — Free
          </a>
        )}
        {(isAndroid || showBoth) && (
          <a
            href={ANDROID_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => trackDownloadClick('android', 'hero_bottom')}
            className={`flex items-center justify-center gap-2 px-4 rounded-xl font-semibold text-sm transition-all ${
              isAndroid
                ? 'gradient-bg gradient-bg-hover text-primary-foreground py-3'
                : 'bg-card border border-border text-foreground py-2.5 hover:bg-muted'
            }`}
          >
            <Play className="w-4 h-4" />
            Get it on Google Play
          </a>
        )}
      </div>
    </div>
  );
};

export default StickyDownloadBar;
