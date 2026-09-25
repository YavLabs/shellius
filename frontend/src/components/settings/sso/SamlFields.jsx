import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Download, Info, KeyRound, ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import SearchableSelect from '@/components/ui/SearchableSelect';
import { SwitchField } from '@/components/ui/switch';
import { rotateSamlSpKey } from '@/services/ssoConfigService';
import {
  ATTRIBUTE_MAPPING_FIELDS,
  MAX_CLOCK_SKEW_SEC,
  MIN_CLOCK_SKEW_SEC,
  certificateStatus,
  inspectCertificateInput,
  nameIdFormatOptions,
  samlAdvisories,
  shortFingerprint,
  signatureAlgorithmOptions,
} from './samlForm';

const LABEL_CLS = 'mb-1.5 block text-sm font-medium text-foreground';
const HELP_CLS = 'mt-1 text-xs text-muted-foreground';
const TEXTAREA_CLS =
  'w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';

function FieldError({ message }) {
  if (!message) return null;
  return <p className="mt-1 text-xs text-destructive">{message}</p>;
}

const ADVISORY_STYLES = {
  error: 'border-destructive/50 bg-destructive/10 text-destructive',
  warning: 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300',
  info: 'border-border bg-muted/40 text-muted-foreground',
};

function Advisory({ level, children }) {
  const Icon = level === 'info' ? Info : level === 'error' ? ShieldAlert : AlertTriangle;
  return (
    <div role={level === 'info' ? undefined : 'alert'} className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${ADVISORY_STYLES[level] || ADVISORY_STYLES.info}`}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/**
 * The stored IdP certificates, as the DTO describes them: subject, validity
 * and SHA-256 fingerprint only. The PEM itself is never returned, which is
 * why the paste box below is always empty on an edit and why leaving it empty
 * keeps what is stored.
 */
function StoredCertificates({ provider }) {
  const summaries = Array.isArray(provider?.idpCertificates) ? provider.idpCertificates : [];
  if (!provider?.hasIdpCertificate) return null;

  if (summaries.length === 0) {
    return (
      <Advisory level="error">
        A certificate is stored for this provider but the server could not read it back. Paste the identity
        provider&apos;s current certificate to replace it.
      </Advisory>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
      <p className="text-xs font-medium text-foreground">
        Stored signing certificate{summaries.length === 1 ? '' : `s (${summaries.length})`}
      </p>
      {summaries.map((summary) => {
        const status = certificateStatus(summary);
        const tone = status.tone === 'danger' ? 'danger' : status.tone === 'warning' ? 'warning' : 'success';
        return (
          <div key={summary.fingerprint || summary.notAfter} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <Badge tone={tone} className="shrink-0">{status.label}</Badge>
            <span className="font-mono text-muted-foreground" title={summary.fingerprint || ''}>
              {shortFingerprint(summary.fingerprint)}
            </span>
            <span className="truncate text-muted-foreground" title={summary.subject || ''}>{summary.subject}</span>
            <span className="text-muted-foreground">
              expires {summary.notAfter ? new Date(summary.notAfter).toLocaleDateString() : 'unknown'}
            </span>
          </div>
        );
      })}
      {summaries.length > 1 && (
        <p className="text-xs text-muted-foreground">
          More than one certificate is a rotation aid: a signature from any of them is accepted, so a new certificate
          can be staged alongside the old one and the old one removed afterwards.
        </p>
      )}
    </div>
  );
}

/**
 * The SP key pair: ours, generated server-side on create, never uploaded and
 * never returned. Only the public certificate and its fingerprint leave the
 * backend. Rotating destroys the old private key, so the metadata has to be
 * re-imported at the IdP afterwards or signed AuthnRequests stop verifying.
 */
function SpKeyActions({ provider, onProviderChanged }) {
  const [rotating, setRotating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');

  if (!provider?.id || provider.provider !== 'saml') return null;

  const summary = provider.samlSpCertificateSummary || null;
  const status = summary ? certificateStatus(summary) : null;

  const handleRotate = async () => {
    setRotating(true);
    setError('');
    try {
      const updated = await rotateSamlSpKey(provider.id);
      setConfirming(false);
      onProviderChanged?.(updated);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to rotate the SP key');
    } finally {
      setRotating(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground">Service Provider key pair</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {provider.hasSpKey
              ? 'Signs our AuthnRequests and decrypts encrypted assertions. The private half never leaves the server.'
              : 'No key pair is stored, so requests cannot be signed and encrypted assertions cannot be decrypted.'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {provider.samlMetadataUrl && (
            <Button asChild type="button" variant="outline" size="sm">
              <a href={provider.samlMetadataUrl} target="_blank" rel="noreferrer">
                <Download className="mr-2 h-3.5 w-3.5" />
                SP metadata
              </a>
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" disabled={rotating} onClick={() => setConfirming((v) => !v)}>
            <KeyRound className="mr-2 h-3.5 w-3.5" />
            Rotate key
          </Button>
        </div>
      </div>

      {status && (
        <p className="text-xs text-muted-foreground">
          Our certificate: <span className="font-mono">{shortFingerprint(summary.fingerprint)}</span> — {status.label}
        </p>
      )}

      {confirming && (
        <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
          <p className="text-xs text-amber-800 dark:text-amber-300">
            Rotating destroys the current private key immediately. Until you re-import the SP metadata (or the new
            certificate) at your identity provider, it will reject our signed AuthnRequests and sign-in will fail.
          </p>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="destructive" disabled={rotating} onClick={handleRotate}>
              {rotating ? 'Rotating…' : 'Rotate now'}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={rotating} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/**
 * SamlFields — the SAML branch of ProviderForm.
 *
 * The three fields at the top are what the backend requires on create
 * (routes/sso.js makes samlIdpEntryPoint, samlIdpEntityId and
 * samlIdpCertificate required for a SAML preset). Everything else is
 * collapsed, defaults to a safe value, and carries help text taken from
 * services/samlService.js rather than invented here.
 *
 * Two behaviours that are NOT configurable, and are stated as such:
 *   - the assertion signature is always required (wantAssertionsSigned is
 *     hardcoded true; an unsigned assertion inside a signed response is the
 *     canonical SAML bypass);
 *   - the audience is always our own EntityID.
 */
export default function SamlFields({ state, onChange, errors = {}, preset, provider, onProviderChanged }) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const set = (patch) => onChange({ ...state, ...patch });

  const cert = inspectCertificateInput(state.idpCertificate);
  const advisories = samlAdvisories(state, provider);
  const hasStoredCertificate = !!provider?.hasIdpCertificate;

  return (
    <div className="space-y-5">
      <SpKeyActions provider={provider} onProviderChanged={onProviderChanged} />

      <div>
        <label className={LABEL_CLS} htmlFor="saml-entry-point">
          IdP sign-in URL <span className="text-destructive">*</span>
        </label>
        <Input
          id="saml-entry-point"
          value={state.idpEntryPoint}
          onChange={(e) => set({ idpEntryPoint: e.target.value })}
          placeholder="https://idp.example.com/sso/saml"
          spellCheck={false}
        />
        <p className={HELP_CLS}>
          Where Shellius sends the browser to start a sign-in (the IdP&apos;s HTTP-Redirect SSO endpoint).
        </p>
        <FieldError message={errors.idpEntryPoint} />
      </div>

      <div>
        <label className={LABEL_CLS} htmlFor="saml-entity-id">
          IdP EntityID <span className="text-destructive">*</span>
        </label>
        <Input
          id="saml-entity-id"
          value={state.idpEntityId}
          onChange={(e) => set({ idpEntityId: e.target.value })}
          placeholder="https://sts.windows.net/00000000-0000-0000-0000-000000000000/"
          spellCheck={false}
          className="font-mono text-xs"
        />
        <p className={HELP_CLS}>
          Must match the assertion&apos;s <span className="font-mono">Issuer</span> exactly. A valid signature only
          proves someone holding that key signed the assertion; this is what says which identity provider it was, so a
          shared or multi-tenant IdP cannot sign in as another tenant&apos;s user.
        </p>
        <FieldError message={errors.idpEntityId} />
      </div>

      <div>
        <label className={LABEL_CLS} htmlFor="saml-idp-cert">
          IdP signing certificate {!hasStoredCertificate && <span className="text-destructive">*</span>}
        </label>
        <StoredCertificates provider={provider} />
        <textarea
          id="saml-idp-cert"
          rows={6}
          className={`${TEXTAREA_CLS} ${hasStoredCertificate ? 'mt-2' : ''}`}
          value={state.idpCertificate}
          onChange={(e) => set({ idpCertificate: e.target.value })}
          spellCheck={false}
          autoComplete="off"
          placeholder={
            hasStoredCertificate
              ? 'Stored — leave blank to keep the current certificate'
              : '-----BEGIN CERTIFICATE-----\nMIID...\n-----END CERTIFICATE-----'
          }
        />
        <p className={HELP_CLS}>
          Paste the PEM, or the bare base64 body your IdP console shows. Paste several, one after another, to trust
          more than one during a rotation (up to 5) — a signature from any of them is accepted.
          {hasStoredCertificate && ' Leaving this blank keeps the certificate that is already stored; it is never shown back to you.'}
        </p>
        {!errors.idpCertificate && !cert.empty && !cert.error && (
          <p className="mt-1 text-xs text-muted-foreground">
            {cert.count} certificate{cert.count === 1 ? '' : 's'} detected. The server parses and verifies them on save.
          </p>
        )}
        <FieldError message={errors.idpCertificate} />
      </div>

      <div className="rounded-md border border-border">
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          aria-expanded={showAdvanced}
          className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
        >
          <span>
            <span className="block text-sm font-semibold text-foreground">Advanced SAML settings</span>
            <span className="block text-xs text-muted-foreground">
              Signature policy, IdP-initiated sign-in, clock skew, NameID format and attribute mapping.
            </span>
          </span>
          {showAdvanced ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
        </button>

        {showAdvanced && (
          <div className="space-y-4 border-t border-border p-4">
            <Advisory level="info">
              The assertion&apos;s own signature is always required and is not configurable: a signature over the
              response envelope says nothing about the assertion inside it. The audience is always this provider&apos;s
              Service Provider EntityID.
            </Advisory>

            <SwitchField
              label="Also require the response envelope to be signed"
              description="Off (default) because many IdPs sign only the assertion. Turning it on additionally requires a signature over the whole response, and makes a missing Destination a refusal."
              checked={state.wantAuthnResponseSigned}
              onCheckedChange={(v) => set({ wantAuthnResponseSigned: v })}
            />

            <SwitchField
              label="Allow IdP-initiated sign-in"
              description="Off (default). An unsolicited assertion carries no InResponseTo, so nothing binds it to a sign-in this server started — it is refused before it is even validated. Turn this on only if people must start from the IdP's app portal."
              checked={state.allowIdpInitiated}
              onCheckedChange={(v) => set({ allowIdpInitiated: v })}
            />

            <SwitchField
              label="Sign our AuthnRequests"
              description="On (default). Uses the Service Provider key pair above. Some IdPs require it; none are harmed by it."
              checked={state.signRequests}
              onCheckedChange={(v) => set({ signRequests: v })}
            />

            <SwitchField
              label="Force re-authentication (ForceAuthn)"
              description="Asks the identity provider to re-prompt for credentials on every Shellius sign-in instead of reusing an existing IdP session."
              checked={state.forceAuthn}
              onCheckedChange={(v) => set({ forceAuthn: v })}
            />

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Minimum signature algorithm</label>
                <SearchableSelect
                  className="w-full"
                  value={state.signatureAlgorithm}
                  onChange={(v) => set({ signatureAlgorithm: v })}
                  searchable={false}
                  clearable={false}
                  options={signatureAlgorithmOptions(state.signatureAlgorithm)}
                />
                <p className={HELP_CLS}>
                  The weakest signature and digest algorithm accepted on an incoming assertion, and the algorithm used
                  to sign our own requests. Anything weaker is refused.
                </p>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="saml-skew">
                  Clock skew (seconds)
                </label>
                <Input
                  id="saml-skew"
                  value={state.clockSkewSec}
                  onChange={(e) => set({ clockSkewSec: e.target.value })}
                  inputMode="numeric"
                  placeholder="60"
                />
                <p className={HELP_CLS}>
                  Tolerance applied to the assertion&apos;s NotBefore / NotOnOrAfter, {MIN_CLOCK_SKEW_SEC}–
                  {MAX_CLOCK_SKEW_SEC}. Raise it only if the IdP and this server disagree about the time.
                </p>
                <FieldError message={errors.clockSkewSec} />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">NameID format</label>
              <SearchableSelect
                className="w-full"
                value={state.identifierFormat}
                onChange={(v) => set({ identifierFormat: v })}
                searchable={false}
                clearable={false}
                options={nameIdFormatOptions(state.identifierFormat)}
              />
              <p className={HELP_CLS}>
                Requested in the AuthnRequest and enforced on the way back: an assertion whose NameID format does not
                match is refused, because a format change rewrites every user&apos;s identifier. The NameID becomes the
                stored subject, so it has to be stable — a transient NameID is always refused.
              </p>
              <FieldError message={errors.identifierFormat} />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="saml-sp-entity-id">
                Service Provider EntityID override
              </label>
              <Input
                id="saml-sp-entity-id"
                value={state.spEntityIdOverride}
                onChange={(e) => set({ spEntityIdOverride: e.target.value })}
                placeholder={provider?.samlMetadataUrl || 'Defaults to the SP metadata URL'}
                spellCheck={false}
                className="font-mono text-xs"
              />
              <p className={HELP_CLS}>
                Leave blank to use the metadata URL above. Only set this if your IdP already has an identifier
                registered for Shellius — it is the audience every assertion must name, so changing it on a live
                provider breaks sign-in until the IdP is updated to match.
              </p>
              <FieldError message={errors.spEntityIdOverride} />
            </div>

            <div>
              <p className="text-xs font-medium text-foreground">Attribute mapping</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Optional. Shellius already tries the common attribute names and OIDs
                {preset?.id && preset.id !== 'saml' ? `, starting with the ones ${preset.label} emits by default` : ''}.
                Fill a box in only to name the exact attribute to read. These six are the only fields that can be
                mapped.
              </p>
              <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {ATTRIBUTE_MAPPING_FIELDS.map((field) => (
                  <div key={field.key}>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor={`saml-attr-${field.key}`}>
                      {field.label}
                    </label>
                    <Input
                      id={`saml-attr-${field.key}`}
                      value={state.attributeMapping?.[field.key] || ''}
                      onChange={(e) =>
                        set({ attributeMapping: { ...state.attributeMapping, [field.key]: e.target.value } })
                      }
                      placeholder={field.placeholder}
                      spellCheck={false}
                      className="font-mono text-xs"
                    />
                  </div>
                ))}
              </div>
              <FieldError message={errors.attributeMapping} />
              <p className={HELP_CLS}>
                Group attributes are recorded for audit only — Shellius does not map identity provider groups to roles
                or groups for any protocol. Use the default group below instead.
              </p>
            </div>
          </div>
        )}
      </div>

      {advisories.map((advisory) => (
        <Advisory key={advisory.message} level={advisory.level}>
          {advisory.message}
        </Advisory>
      ))}
    </div>
  );
}
