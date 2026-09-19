
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
  sm: { box: 'h-7 w-7 rounded-md', icon: 'h-4 w-4', mark: 'h-7 w-7', text: 'text-[19px]', gap: 'gap-[7px]' },
  md: { box: 'h-9 w-9 rounded-lg', icon: 'h-5 w-5', mark: 'h-9 w-9', text: 'text-[25px]', gap: 'gap-[9px]' },
  lg: { box: 'h-12 w-12 rounded-lg', icon: 'h-6 w-6', mark: 'h-12 w-12', text: 'text-[33px]', gap: 'gap-3' },
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
// Brand assets (frontend/public/brand — copied verbatim from the brand kit).
const MARK_SRC = '/brand/shellius-mark.svg';

/**
 * BrandMark — the gradient chip (brand/shellius-mark.svg). A deployment's
 * VITE_BRAND_LOGO_SHORT_URL / VITE_BRAND_LOGO_URL still wins.
 */
export function BrandMark({ size = 'md', className = '' }) {
  const s = pickSize(size);
  const src = LOGO_SHORT_URL || LOGO_URL;
  if (src) {
    return (
      <div className={`flex shrink-0 items-center justify-center bg-primary ${s.box} ${className}`}>
        <img src={src} alt={BRAND_NAME} className={`${s.icon} object-contain`} />
      </div>
    );
  }
  return <img src={MARK_SRC} alt={BRAND_NAME} className={`shrink-0 ${s.mark} ${className}`} draggable="false" />;
}

/**
 * BrandWordmark — "SHELL▮US": Space Grotesk 700, −2% tracking, the I drawn
 * as the gradient cursor block (brand guideline 01). `compact` renders the
 * mixed-case "Shellius" for product chrome under 24px tall. A custom
 * VITE_BRAND_NAME renders as plain text.
 */
export function BrandWordmark({ compact = false, className = '', nudge = false }) {
  // `nudge`: 1.5px optical drop for the sidebar lockup.
  const n = nudge ? 'mt-[1.5px]' : '';
  if (BRAND_NAME !== 'Shellius' || compact) {
    return <span className={`font-brand font-bold leading-none tracking-[-0.02em] text-foreground ${className}`}>{BRAND_NAME}</span>;
  }
  return (
    // Baseline-aligned so the cursor bar (exactly cap height, .wordmark-bar)
    // sits on the letters' baseline and tops out with them.
    <span className={`inline-flex items-baseline font-brand font-bold uppercase leading-none tracking-[-0.02em] text-foreground ${className}`} aria-label={BRAND_NAME}>
      <span aria-hidden="true" className={n}>SHELL</span>
      <span
        aria-hidden="true"
        className={`wordmark-bar bg-brand-gradient mx-[0.07em] inline-block w-[0.34em] rounded-[0.05em] ${n}`}
      />
      <span aria-hidden="true" className={n}>US</span>
    </span>
  );
}

/**
 * BrandLogo — horizontal lockup: mark + wordmark (brand guideline 01,
 * "Primary — horizontal"). `compact` uses the mixed-case wordmark.
 */
export default function BrandLogo({ size = 'md', className = '', wordmarkClassName = '', showWordmark = true, compact = false, nudge = false }) {
  const s = pickSize(size);
  return (
    <div className={`flex items-center ${s.gap} ${className}`}>
      <BrandMark size={size} />
      {showWordmark && <BrandWordmark compact={compact} nudge={nudge} className={`${s.text} ${wordmarkClassName}`} />}
    </div>
  );
}

/**
 * BrandLockupStacked — mark above wordmark (brand guideline 01, "Stacked":
 * splash, login, print covers). Wordmark ≈ 0.44 of the mark height.
 */
export function BrandLockupStacked({ className = '' }) {
  return (
    <div className={`flex flex-col items-center gap-5 ${className}`}>
      <BrandMark size="lg" className="h-16 w-16" />
      <BrandWordmark className="text-[30px]" />
    </div>
  );
}
