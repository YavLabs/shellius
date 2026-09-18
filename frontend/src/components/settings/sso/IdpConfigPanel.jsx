import { Input } from '@/components/ui/input';
import { CopyButton } from '@/components/settings/shared';

/**
 * computeIdpFields — the exact set of values an admin needs to paste into
 * each identity provider's console, per preset. `callbackUrl` is the saved
 * provider's DTO `callbackUrl` (routes to `GET /api/auth/sso/callback/:id`
 * on the backend — see backend/src/routes/sso.js + ssoConfigService's
 * callbackUrlFor, which builds it from config.publicBaseUrl). It's empty
 * until the provider is first saved (the id doesn't exist yet), so fields
 * that depend on it render a "available after saving" placeholder;
 * origin-only fields (JS origin, homepage URL, sign-out URL) don't depend
 * on the id and can be shown immediately.
 */
export function computeIdpFields(preset, callbackUrl) {
  const origin = window.location.origin;
  const loginUrl = `${origin}/login`;
  const pending = !callbackUrl;

  switch (preset?.id) {
    case 'google':
      return [
        { label: 'Authorized JavaScript origin', value: origin },
        { label: 'Authorized redirect URI', value: callbackUrl, pending },
      ];
    case 'entra':
      return [
        { label: 'Platform', value: 'Web', copyable: false },
        { label: 'Redirect URI', value: callbackUrl, pending },
      ];
    case 'okta':
      return [
        { label: 'Sign-in redirect URI', value: callbackUrl, pending },
        { label: 'Sign-out redirect URI', value: loginUrl },
        { label: 'Initiate login URI', value: loginUrl },
      ];
    case 'auth0':
      return [
        { label: 'Allowed callback URLs', value: callbackUrl, pending },
        { label: 'Allowed logout URLs', value: loginUrl },
        { label: 'Allowed web origins', value: origin },
      ];
    case 'github':
      return [
        { label: 'Homepage URL', value: origin },
        { label: 'Authorization callback URL', value: callbackUrl, pending },
      ];
    case 'generic':
      return [{ label: 'Redirect URI', value: callbackUrl, pending }];
    default:
      return [];
  }
}

function IdpField({ label, value, pending, copyable = true }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      {pending ? (
        <p className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          Available after saving
        </p>
      ) : copyable ? (
        <div className="flex items-center gap-2">
          <Input value={value} readOnly className="font-mono text-xs bg-muted/40" />
          <CopyButton text={value} />
        </div>
      ) : (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-foreground">{value}</p>
      )}
    </div>
  );
}

/**
 * IdpConfigPanel — "Configure your identity provider" panel: the values to
 * paste into the IdP console (one labeled read-only field per value) plus
 * the preset's numbered setup steps. Shown inside ProviderForm for both
 * create and edit.
 */
function IdpConfigPanel({ preset, callbackUrl }) {
  const fields = computeIdpFields(preset, callbackUrl);
  if (fields.length === 0 && !preset?.setupSteps?.length) return null;

  return (
    <div className="rounded-md border border-border p-4 space-y-4">
      <div>
        <h4 className="text-sm font-semibold text-foreground">Configure your identity provider</h4>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Paste these values into {preset?.label || 'your identity provider'}'s console.
        </p>
      </div>

      {fields.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {fields.map((f) => (
            <IdpField key={f.label} {...f} />
          ))}
        </div>
      )}

      {preset?.setupSteps?.length > 0 && (
        <ol className="space-y-2.5 border-t border-border pt-4">
          {preset.setupSteps.map((step, i) => (
            <li key={step.title} className="flex gap-3 text-sm">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground">
                {i + 1}
              </span>
              <span>
                <span className="block font-medium text-foreground">{step.title}</span>
                <span className="block text-xs text-muted-foreground">{step.body}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export default IdpConfigPanel;
