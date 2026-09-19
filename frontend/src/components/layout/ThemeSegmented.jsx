import { useId } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import { useTheme } from '@/context/ThemeContext';
import { cn } from '@/lib/utils';

const OPTIONS = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

/**
 * "Theme" row with an icon-only Light / Dark / System switch — the phone
 * replacement for the topbar ThemeMenu (menu drawer and account menu). The
 * names live in each button's accessible label and tooltip.
 */
function ThemeSegmented({ className }) {
  const { theme, setTheme } = useTheme();
  const labelId = useId();
  return (
    <div className={cn('flex items-center justify-between gap-3', className)}>
      <span id={labelId} className="text-sm text-muted-foreground">
        Theme
      </span>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className="flex rounded-lg border border-border bg-muted/40 p-0.5"
      >
        {OPTIONS.map(({ value, label, icon: Icon }) => {
          const active = theme === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={label}
              title={label}
              onClick={() => setTheme(value)}
              className={cn(
                'flex h-8 w-9 items-center justify-center rounded-md transition-colors',
                active ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default ThemeSegmented;
