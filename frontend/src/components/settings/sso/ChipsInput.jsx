import { useState } from 'react';
import { Badge } from '@/components/ui/badge';

/**
 * ChipsInput — type a value and press Enter/comma to add it as a removable
 * chip. Generic version of the domain-chips input used across SSO provider
 * config (allowed email domains, allowed GitHub organizations).
 */
export default function ChipsInput({
  values,
  onChange,
  placeholder = 'Add…',
  emptyPlaceholder,
  normalize = (v) => v.trim(),
  validate,
  helpText,
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');

  const addValue = (raw) => {
    const value = normalize(raw);
    if (!value) return;
    if (validate) {
      const msg = validate(value);
      if (msg) {
        setError(msg);
        return;
      }
    }
    if (values.includes(value)) {
      setDraft('');
      return;
    }
    setError('');
    onChange([...values, value]);
    setDraft('');
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addValue(draft);
    } else if (e.key === 'Backspace' && !draft && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };

  return (
    <div>
      <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5">
        {values.map((v) => (
          <Badge
            key={v}
            onRemove={() => onChange(values.filter((x) => x !== v))}
            removeLabel={`Remove ${v}`}
          >
            {v}
          </Badge>
        ))}
        <input
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setError(''); }}
          onKeyDown={handleKeyDown}
          onBlur={() => draft && addValue(draft)}
          placeholder={values.length === 0 ? (emptyPlaceholder || placeholder) : placeholder}
          className="min-w-[10ch] flex-1 border-0 bg-transparent px-1 py-0.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
      </div>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      {helpText && <p className="mt-1 text-xs text-muted-foreground">{helpText}</p>}
    </div>
  );
}

const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

/** Preconfigured ChipsInput for email domains (lowercased, "@" stripped, validated). */
export function DomainChipsInput({ domains, onChange }) {
  return (
    <ChipsInput
      values={domains}
      onChange={onChange}
      normalize={(v) => v.trim().toLowerCase().replace(/^@/, '')}
      validate={(v) => (DOMAIN_RE.test(v) ? '' : `"${v}" doesn't look like a valid domain.`)}
      emptyPlaceholder="acme.com (blank = any domain)"
      placeholder="Add domain…"
      helpText="Only these email domains may sign in or be provisioned via this provider. Leave empty to allow any domain."
    />
  );
}

const GITHUB_ORG_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;

/** Preconfigured ChipsInput for GitHub organization slugs. */
export function GithubOrgChipsInput({ orgs, onChange }) {
  return (
    <ChipsInput
      values={orgs}
      onChange={onChange}
      normalize={(v) => v.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\/.*$/, '')}
      validate={(v) => (GITHUB_ORG_RE.test(v) ? '' : `"${v}" doesn't look like a valid GitHub organization.`)}
      emptyPlaceholder="acme-inc (blank = any organization)"
      placeholder="Add organization…"
      helpText="Only members of these GitHub organizations may sign in or be provisioned. Requires the read:org scope. Leave empty to allow any GitHub account."
    />
  );
}
