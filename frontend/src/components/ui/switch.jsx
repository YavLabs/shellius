import { cn } from '@/lib/utils';

const SIZES = {
  md: { track: 'h-6 w-11', thumb: 'h-5 w-5', on: 'translate-x-5' },
  sm: { track: 'h-5 w-9', thumb: 'h-4 w-4', on: 'translate-x-4' },
};

/**
 * Switch — accessible on/off toggle (role="switch").
 *
 * The thumb takes its colour from the theme instead of a fixed white: in dark
 * mode `primary` is near-white, so a white thumb on a checked track vanished.
 * Checked: primary track + primary-foreground thumb. Unchecked: muted track +
 * background (light) / foreground (dark) thumb.
 */
function Switch({ checked, onCheckedChange, size = 'md', disabled = false, className, ...props }) {
  const s = SIZES[size] || SIZES.md;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!checked}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
      className={cn(
        'relative inline-flex shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
        s.track,
        checked ? 'bg-primary' : 'bg-muted-foreground/30',
        className
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none inline-block transform rounded-full shadow ring-0 transition duration-200 ease-in-out',
          s.thumb,
          checked ? cn(s.on, 'bg-primary-foreground') : 'translate-x-0 bg-background dark:bg-foreground'
        )}
      />
    </button>
  );
}

export { Switch };
export default Switch;
