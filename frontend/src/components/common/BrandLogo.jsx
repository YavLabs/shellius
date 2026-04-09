import { Terminal } from 'lucide-react';

/**
 * BrandLogo — the canonical brand mark for Shellius (or a re-branded
 * deployment). Used everywhere a "Shellius" wordmark + icon appears in
 * the UI: sidebar header, top of every auth screen, install page hero,
 * empty-state cards, etc.
 *
 * Branding override
 * -----------------
 * If `VITE_BRAND_LOGO_URL` is set at build time, the icon is rendered
 * as an `<img>` from that URL. If `VITE_BRAND_NAME` is also set, that
 * replaces the "Shellius" wordmark. Otherwise the default Terminal
 * lucide icon + "Shellius" text is used.
 *
 * For the icon-only variant (sidebar collapsed, favicon-style placements,
 * tight cards) use the smaller `BrandMark` export.
 *
 * Styling
 * -------
 * The icon container always uses `bg-primary text-primary-foreground`
 * so it inherits the current theme (light → coral, dark → black with
 * coral icon, etc.). Callers can override the size with the `size`
 * prop ("sm" | "md" | "lg") which scales the square + the icon.
 *
 * NOTE: this component is purely presentational. It does not link
 * anywhere — wrap it in a `<Link to="/">` if you need it to be
 * clickable (the Sidebar does this).
 */

const SIZE_MAP = {
  sm: { box: 'h-7 w-7 rounded-md', icon: 'h-4 w-4', text: 'text-sm' },
  md: { box: 'h-9 w-9 rounded-lg', icon: 'h-5 w-5', text: 'text-base' },
  lg: { box: 'h-12 w-12 rounded-lg', icon: 'h-6 w-6', text: 'text-lg' },
};

// Read once at module load — Vite inlines import.meta.env.* at build time.
const LOGO_URL = import.meta.env.VITE_BRAND_LOGO_URL || '';
const LOGO_SHORT_URL = import.meta.env.VITE_BRAND_LOGO_SHORT_URL || '';
const BRAND_NAME = import.meta.env.VITE_BRAND_NAME || 'Shellius';

function pickSize(size) {
  return SIZE_MAP[size] || SIZE_MAP.md;
}

/**
 * BrandMark — the icon-only square. Renders the override icon when
 * VITE_BRAND_LOGO_SHORT_URL (preferred for compact placements) or
 * VITE_BRAND_LOGO_URL is set, otherwise the default Terminal lucide.
 */
export function BrandMark({ size = 'md', className = '' }) {
  const s = pickSize(size);
  const src = LOGO_SHORT_URL || LOGO_URL;

  if (src) {
    // Custom branded image. Render against the same primary background
    // square so corner radius and contrast match the default mark.
    return (
      <div
        className={`flex shrink-0 items-center justify-center bg-primary ${s.box} ${className}`}
      >
        <img
          src={src}
          alt={BRAND_NAME}
          className={`${s.icon} object-contain`}
        />
      </div>
    );
  }

  return (
    <div
      className={`flex shrink-0 items-center justify-center bg-primary ${s.box} ${className}`}
    >
      <Terminal className={`${s.icon} text-primary-foreground`} />
    </div>
  );
}

/**
 * BrandLogo — the icon + wordmark combo. The wordmark text is muted to
 * match the existing inline patterns (`text-foreground tracking-tight
 * font-semibold`). Pass `wordmarkClassName` to override.
 */
export default function BrandLogo({
  size = 'md',
  className = '',
  wordmarkClassName = '',
  showWordmark = true,
}) {
  const s = pickSize(size);
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <BrandMark size={size} />
      {showWordmark && (
        <span
          className={`font-semibold tracking-tight text-foreground ${s.text} ${wordmarkClassName}`}
        >
          {BRAND_NAME}
        </span>
      )}
    </div>
  );
}
