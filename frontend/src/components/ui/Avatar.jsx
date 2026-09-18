import { useEffect, useState } from 'react';

/**
 * Avatar — circular user avatar. Renders the user's profile picture
 * (avatarUrl — SSO picture or a custom uploaded `data:` URL) when present,
 * with a graceful fallback to initials if the image is missing or fails to
 * load. Consistent sizing + a subtle ring everywhere it's used.
 *
 * Props:
 *   name?      {string}  display name (used for initials + alt)
 *   email?     {string}  fallback for initials/alt
 *   src?       {string}  image URL (avatarUrl) — `avatarUrl` also accepted
 *   avatarUrl? {string}  alias for `src`
 *   size?      'xs'|'sm'|'md'|'lg'|'xl'
 *   ring?      {boolean} show a subtle ring (default true)
 *   className?
 */
const SIZES = {
  xs: 'h-6 w-6 text-[10px]',
  sm: 'h-7 w-7 text-xs',
  md: 'h-9 w-9 text-sm',
  lg: 'h-12 w-12 text-base',
  xl: 'h-16 w-16 text-lg',
};

export function initialsOf(name, email) {
  const s = (name || email || 'U').trim();
  if (!s) return 'U';
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}

export default function Avatar({ name, email, src, avatarUrl, size = 'md', ring = true, className = '' }) {
  const imgSrc = src || avatarUrl;
  const [errored, setErrored] = useState(false);

  // Reset the error flag if the image source changes (e.g. after a profile
  // photo upload) so a previously-broken avatar can recover.
  useEffect(() => {
    setErrored(false);
  }, [imgSrc]);

  const showImg = imgSrc && !errored;

  return (
    <span
      className={`inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full bg-primary/10 font-semibold uppercase text-primary ${
        ring ? 'ring-1 ring-border' : ''
      } ${SIZES[size] || SIZES.md} ${className}`}
      title={name || email || undefined}
    >
      {showImg ? (
        <img
          src={imgSrc}
          alt={name || email || 'avatar'}
          className="h-full w-full object-cover"
          // Google profile images can 403 when a referrer is sent.
          referrerPolicy="no-referrer"
          onError={() => setErrored(true)}
        />
      ) : (
        initialsOf(name, email)
      )}
    </span>
  );
}
