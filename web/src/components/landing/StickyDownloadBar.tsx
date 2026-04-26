import { useState, useEffect } from 'react';
import { AppStoreBadge, GooglePlayBadge } from './StoreBadge';
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
          <AppStoreBadge
            href={APP_STORE_URL}
            onClick={() => trackDownloadClick('ios', 'hero_bottom')}
          />
        )}
        {(isAndroid || showBoth) && (
          <GooglePlayBadge
            href={ANDROID_URL}
            onClick={() => trackDownloadClick('android', 'hero_bottom')}
          />
        )}
      </div>
    </div>
  );
};

export default StickyDownloadBar;
