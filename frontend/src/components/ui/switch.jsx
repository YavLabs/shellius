import { useId } from 'react';
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

/**
 * SwitchField — a settings row: label (+ optional description) on the left,
 * Switch on the right, vertically centred. The whole label is clickable and
 * wired to the switch via aria-labelledby / aria-describedby.
 *
 * `bordered` renders the row as its own card (rounded border + padding),
 * matching the standalone setting rows used across Settings.
 */
function SwitchField({ label, description, checked, onCheckedChange, disabled = false, bordered = false, size, className, children }) {
  const id = useId();
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-4',
        bordered && 'rounded-lg border border-border p-4',
        disabled && 'opacity-60',
        className
      )}
    >
      <label htmlFor={id} className={cn('min-w-0 flex-1', disabled ? 'cursor-not-allowed' : 'cursor-pointer')}>
        <span id={`${id}-label`} className="block text-sm font-medium text-foreground">
          {label}
        </span>
        {description && (
          <span id={`${id}-desc`} className="mt-0.5 block text-xs text-muted-foreground">
            {description}
          </span>
        )}
        {children}
      </label>
      <Switch
        id={id}
        size={size}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-desc` : undefined}
        className="disabled:opacity-100"
      />
    </div>
  );
}

export { Switch, SwitchField };
export default Switch;
