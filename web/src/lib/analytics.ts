declare global {
  interface Window {
    dataLayer: unknown[];
    gtag: (...args: unknown[]) => void;
  }
}

// GA4 is loaded via index.html script tag — no dynamic injection needed
export function initGA() {
  // no-op: gtag is initialized in index.html
}

export function trackPageView(path: string, title?: string) {
  if (!window.gtag) return;
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
