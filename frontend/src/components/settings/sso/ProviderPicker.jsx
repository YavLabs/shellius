import { SSO_PROVIDERS } from '@/config/ssoProviders';
import { Badge } from '@/components/ui/badge';
import ProviderIcon from './ProviderIcon';

/**
 * ProviderPicker — grid of identity provider preset cards shown inside the
 * "Add provider" dialog. Selecting a (non-disabled) preset hands it to
 * `onSelect`, which opens the ProviderForm.
 */
export default function ProviderPicker({ onSelect }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {SSO_PROVIDERS.map((provider) => (
        <button
          key={provider.id}
          type="button"
          disabled={provider.disabled}
          onClick={() => onSelect(provider)}
          className={[
            'group relative flex flex-col items-start gap-3 rounded-lg border p-4 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card',
            provider.disabled
              ? 'cursor-not-allowed border-border bg-muted/30 opacity-60'
              : 'cursor-pointer border-border bg-card hover:border-primary/50 hover:bg-accent',
          ].join(' ')}
        >
          {provider.disabled && (
            <Badge tone="neutral" className="absolute right-3 top-3">
              Coming soon
            </Badge>
          )}
          <ProviderIcon
            presetId={provider.id}
            className={[
              'h-6 w-6',
              provider.disabled ? 'text-muted-foreground' : 'text-foreground group-hover:text-primary',
            ].join(' ')}
          />
          <div>
            <p className="text-sm font-semibold text-foreground">{provider.label}</p>
            <p className="mt-0.5 text-xs text-muted-foreground leading-snug">{provider.description}</p>
          </div>
        </button>
      ))}
    </div>
  );
}
