import { useState } from 'react';

/**
 * Avatar — circular user avatar. Renders the user's profile picture
 * (avatarUrl, e.g. from Google SSO) when present, otherwise initials.
 *
 * Props:
 *   name?   {string}  display name (used for initials + alt)
 *   email?  {string}  fallback for initials/alt
 *   src?    {string}  image URL (avatarUrl)
 *   size?   'xs'|'sm'|'md'|'lg'|'xl'
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

export default function Avatar({ name, email, src, size = 'md', className = '' }) {
  const [errored, setErrored] = useState(false);
  const showImg = src && !errored;

  return (
    <span
      className={`inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full bg-primary/10 font-semibold uppercase text-primary ${SIZES[size] || SIZES.md} ${className}`}
      title={name || email || undefined}
    >
      {showImg ? (
        <img
          src={src}
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
