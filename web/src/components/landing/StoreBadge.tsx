export interface StoreBadgeProps {
  href: string;
  onClick?: () => void;
  className?: string;
}

export function AppStoreBadge({ href, onClick, className }: StoreBadgeProps): JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onClick}
      className={`inline-flex items-center justify-center gap-3 bg-black text-white rounded-xl border border-white/10 px-5 py-3 transition-all hover:scale-105 w-full sm:w-auto ${className ?? ''}`}
    >
      {/* Apple logo SVG */}
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="white"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
      </svg>
      <span className="flex flex-col items-start">
        <span className="text-[10px] leading-none opacity-90">Download on the</span>
        <span className="text-lg leading-tight font-semibold tracking-tight">App Store</span>
      </span>
    </a>
  );
}

export function GooglePlayBadge({ href, onClick, className }: StoreBadgeProps): JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onClick}
      className={`inline-flex items-center justify-center gap-3 bg-black text-white rounded-xl border border-white/10 px-5 py-3 transition-all hover:scale-105 w-full sm:w-auto ${className ?? ''}`}
    >
      {/* Google Play multicolor triangle */}
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        {/* Blue — top-left sector */}
        <path d="M3 3.269v17.462a1 1 0 0 0 1.514.857l8.043-4.65-2.828-2.829L3 3.269z" fill="#00D2FF" />
        {/* Green — top-right sector */}
        <path d="M20.485 10.513 17.1 8.6l-3.372 3.372 3.372 3.37 3.414-1.97a1 1 0 0 0 0-1.859z" fill="#00F076" />
        {/* Yellow — bottom-right sector */}
        <path d="M13.729 11.972 4.514 2.757A1 1 0 0 0 3 3.27l6.9 9.703 3.829-1z" fill="#FFCE00" />
        {/* Red — bottom-left sector */}
        <path d="M9.9 13.027 3 22.73a1 1 0 0 0 1.514.857l9.215-5.322-3.829-3.238z" fill="#FF3A44" />
      </svg>
      <span className="flex flex-col items-start">
        <span className="text-[10px] leading-none uppercase tracking-wide opacity-90">GET IT ON</span>
        <span className="text-lg leading-tight font-semibold tracking-tight">Google Play</span>
      </span>
    </a>
  );
}
