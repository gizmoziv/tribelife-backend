import icon from '@/assets/tribelife-icon.png';

interface LogoProps {
  /** Tailwind height classes for the flame/chat icon. */
  iconClassName?: string;
  /** Tailwind size/weight classes for the wordmark. */
  textClassName?: string;
  /** Extra classes for the wrapper. */
  className?: string;
}

/**
 * TribeLife brand lockup: the original flame + chat icon (untouched) paired
 * with a live "tribelife" wordmark — one word, lowercase, set in the site's
 * display font (Manrope) at extra-bold weight in the theme's foreground color
 * for a cleaner, more modern feel.
 */
const Logo = ({
  iconClassName = 'h-10 md:h-14',
  textClassName = 'text-2xl md:text-4xl',
  className = '',
}: LogoProps) => (
  <span className={`inline-flex items-center gap-2 md:gap-2.5 ${className}`}>
    <img
      src={icon}
      alt="TribeLife - Local Community Matching App"
      className={`${iconClassName} w-auto`}
    />
    <span
      className={`font-display font-extrabold lowercase tracking-tight leading-none text-foreground ${textClassName}`}
    >
      tribelife
    </span>
  </span>
);

export default Logo;
