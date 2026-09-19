import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/settings/shared';
import { useUnsavedChanges } from '@/components/admin/AdminFrameContext';
import { getOrg, updateOrg } from '@/services/orgService';
import { useAuth } from '@/context/AuthContext';

/** Administration → Organization → General (org.update). */
function OrgTab() {
  const { user } = useAuth();
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  // Last loaded / saved values — edits that differ from these are unsaved.
  const [baseline, setBaseline] = useState({ name: '', domain: '', logoUrl: '' });

  const apply = (next) => {
    setName(next.name);
    setDomain(next.domain);
    setLogoUrl(next.logoUrl);
    setBaseline(next);
  };

  useEffect(() => {
    setLoading(true);
    getOrg()
      .then((org) => {
        if (org) {
          apply({
            name: org.name || user?.orgName || user?.org?.name || '',
            domain: org.domain || '',
            logoUrl: org.logoUrl || '',
          });
        }
      })
      .catch(() => {
        // Fall back to auth context values
        apply({ name: user?.orgName || user?.org?.name || '', domain: '', logoUrl: '' });
      })
      .finally(() => setLoading(false));
    // Load once per org; the permission re-check on focus replaces `user`
    // and must not wipe unsaved edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.orgId]);

  useUnsavedChanges(
    !loading && (name !== baseline.name || domain !== baseline.domain || logoUrl !== baseline.logoUrl)
  );

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await updateOrg({ name: name.trim(), domain: domain.trim() || undefined, logoUrl: logoUrl.trim() || undefined });
      setBaseline({ name, domain, logoUrl });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      title="General"
      description="Organization name, domain and logo, shown across the platform."
    >
      {loading ? (
        <div className="space-y-3 py-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-9 animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : (
        <form onSubmit={handleSave} className="space-y-4">
          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          {saved && (
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
              Saved successfully.
            </div>
          )}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-foreground">
              Organization Name <span className="text-destructive">*</span>
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Corp"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-foreground">
              Domain
            </label>
            <Input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="acme.example.com"
              type="text"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Used for SSO redirect URIs and email verification.
            </p>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-foreground">
              Logo URL
            </label>
            <Input
              value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
              placeholder="https://cdn.example.com/logo.png"
              type="url"
            />
          </div>
          <div className="pt-1">
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving...' : 'Save changes'}
            </Button>
          </div>
        </form>
      )}
    </SectionCard>
  );
}

export default OrgTab;
