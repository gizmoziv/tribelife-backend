const GA_ID = import.meta.env.VITE_GA4_MEASUREMENT_ID as string | undefined;
const IS_PROD = import.meta.env.PROD;

declare global {
  interface Window {
    dataLayer: unknown[];
    gtag: (...args: unknown[]) => void;
  }
}

export function initGA() {
  if (!GA_ID || !IS_PROD) return;
  const script = document.createElement('script');
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  script.async = true;
  document.head.appendChild(script);
  window.dataLayer = window.dataLayer || [];
  window.gtag = function (...args: unknown[]) { window.dataLayer.push(args); };
  window.gtag('js', new Date());
  window.gtag('config', GA_ID, { send_page_view: false });
}

export function trackPageView(path: string, title?: string) {
  if (!GA_ID || !window.gtag) return;
  window.gtag('event', 'page_view', { page_path: path, page_title: title });
}

export type DownloadLocation = 'header' | 'footer' | 'hero_top' | 'hero_bottom' | 'cta_bottom';
export type DownloadPlatform = 'ios' | 'android';

export function trackDownloadClick(platform: DownloadPlatform, location: DownloadLocation) {
  if (!window.gtag) return;
  window.gtag('event', 'download_click', { platform, location });
}

export function trackSupportFormStart() {
  if (!window.gtag) return;
  window.gtag('event', 'support_form_start');
}

export function trackSupportFormSubmit(subject: string) {
  if (!window.gtag) return;
  window.gtag('event', 'support_form_submit', { subject_preview: subject.substring(0, 50) });
}

export function trackSupportFormError(error: string) {
  if (!window.gtag) return;
  window.gtag('event', 'support_form_error', { error_message: error });
}

export function trackNavClick(section: string) {
  if (!window.gtag) return;
  window.gtag('event', 'nav_click', { section });
}
