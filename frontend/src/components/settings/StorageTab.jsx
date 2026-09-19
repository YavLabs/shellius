import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import SearchableSelect from '@/components/ui/SearchableSelect';
import PasswordInput from '@/components/ui/PasswordInput';
import { SwitchField } from '@/components/ui/switch';
import { SectionCard } from '@/components/settings/shared';
import { useUnsavedChanges } from '@/components/admin/AdminFrameContext';
import {
  getStorageConfig,
  saveStorageConfig,
  deleteStorageConfig,
  testStorageConfig,
} from '@/services/storageConfigService';

// Mirrors the shadcn <Input> default styling so PasswordInput (raw input) matches.
const SHADCN_INPUT_CLS =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

/** Administration → Integrations → Storage (settings.storage). */
const STORAGE_PROVIDERS = [
  { value: 'minio', label: 'MinIO (self-hosted, S3-compatible)' },
  { value: 's3', label: 'AWS S3' },
  { value: 'azure', label: 'Azure Blob Storage' },
];

function StorageTab() {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const [provider, setProvider] = useState('minio');
  const [endpoint, setEndpoint] = useState('');
  const [region, setRegion] = useState('');
  const [bucket, setBucket] = useState('');
  const [accessKey, setAccessKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [useSsl, setUseSsl] = useState(false);
  const [forcePathStyle, setForcePathStyle] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    return getStorageConfig()
      .then((c) => {
        setConfig(c);
        setProvider(c?.provider || 'minio');
        setEndpoint(c?.endpoint || '');
        setRegion(c?.region || '');
        setBucket(c?.bucket || '');
        setAccessKey(c?.accessKey || '');
        setSecretKey('');
        setUseSsl(c?.useSsl ?? false);
        setForcePathStyle(c?.forcePathStyle ?? true);
      })
      .catch((err) =>
        setError(err?.response?.data?.error?.message || err.message || 'Failed to load storage config')
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const isAzure = provider === 'azure';
  const isS3 = provider === 's3';

  const dirty =
    !loading &&
    (provider !== (config?.provider || 'minio') ||
      endpoint !== (config?.endpoint || '') ||
      region !== (config?.region || '') ||
      bucket !== (config?.bucket || '') ||
      accessKey !== (config?.accessKey || '') ||
      secretKey !== '' ||
      useSsl !== (config?.useSsl ?? false) ||
      forcePathStyle !== (config?.forcePathStyle ?? true));
  useUnsavedChanges(dirty);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const body = { provider, endpoint, region, bucket, accessKey, useSsl, forcePathStyle };
      if (secretKey) body.secretKey = secretKey;
      await saveStorageConfig(body);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      await refresh();
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message || 'Failed to save storage config');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setError('');
    try {
      const r = await testStorageConfig();
      setTestResult({ ok: true, message: `Storage reachable — bucket "${r.bucket}" ready.` });
    } catch (err) {
      setTestResult({
        ok: false,
        message: err?.response?.data?.error?.message || err.message || 'Test failed',
      });
    } finally {
      setTesting(false);
    }
  };

  const handleReset = async () => {
    if (!window.confirm('Delete the storage override? Falls back to environment defaults.')) return;
    setError('');
    try {
      await deleteStorageConfig();
      await refresh();
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message || 'Failed to delete storage config');
    }
  };

  return (
    <SectionCard
      title="Object storage"
      description="Where session recordings and uploads are stored. Use the bundled MinIO container, or bring your own AWS S3 / Azure Blob — DB settings here override environment variables with no restart."
    >
      {loading ? (
        <div className="space-y-2 py-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          {saved && (
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
              Storage configuration saved.
            </div>
          )}
          {config?.source === 'env' && (
            <div className="rounded-md border border-blue-500/40 bg-blue-500/10 px-3 py-2 text-sm text-blue-700 dark:text-blue-300">
              Currently using <strong>environment defaults</strong>. Saving here creates a database
              override.
            </div>
          )}
          {!config?.configured && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
              Storage not configured — session recordings are disabled until you set a provider and
              credentials.
            </div>
          )}

          <div>
            <label className="mb-1 flex items-center text-xs font-medium text-muted-foreground">
              Provider <span className="text-destructive">*</span>
            </label>
            <SearchableSelect
              value={provider}
              onChange={(v) => setProvider(v)}
              searchable={false}
              clearable={false}
              options={STORAGE_PROVIDERS.map((p) => ({ value: p.value, label: p.label }))}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className={isAzure ? 'sm:col-span-2' : ''}>
              <label className="mb-1 flex items-center text-xs font-medium text-muted-foreground">
                {isAzure ? 'Blob endpoint (optional)' : 'Endpoint'}
              </label>
              <Input
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder={
                  isAzure
                    ? 'https://<account>.blob.core.windows.net (blank = default)'
                    : isS3
                      ? 'blank for AWS, or https://s3.custom.com'
                      : 'http://minio:9000'
                }
              />
            </div>
            {!isAzure && (
              <div>
                <label className="mb-1 flex items-center text-xs font-medium text-muted-foreground">
                  Region
                </label>
                <Input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="us-east-1" />
              </div>
            )}
            <div>
              <label className="mb-1 flex items-center text-xs font-medium text-muted-foreground">
                {isAzure ? 'Container' : 'Bucket'}
              </label>
              <Input value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="shellius-recordings" />
            </div>
            <div>
              <label className="mb-1 flex items-center text-xs font-medium text-muted-foreground">
                {isAzure ? 'Account name' : 'Access key'}
              </label>
              <Input
                value={accessKey}
                onChange={(e) => setAccessKey(e.target.value)}
                placeholder={isAzure ? 'storageaccount' : 'AKIA... / minioadmin'}
                autoComplete="off"
              />
            </div>
            <div>
              <label className="mb-1 flex items-center text-xs font-medium text-muted-foreground">
                {isAzure ? 'Account key' : 'Secret key'}
              </label>
              <PasswordInput
                className={SHADCN_INPUT_CLS}
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
                placeholder={config?.hasSecretKey ? 'Stored — leave blank to keep' : ''}
                autoComplete="new-password"
              />
            </div>
          </div>

          {!isAzure && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <SwitchField
                bordered
                label="Use SSL/TLS"
                description="Connect to the endpoint over HTTPS."
                checked={useSsl}
                onCheckedChange={setUseSsl}
              />
              <SwitchField
                bordered
                label="Force path-style addressing"
                description="Needed for MinIO and most self-hosted S3."
                checked={forcePathStyle}
                onCheckedChange={setForcePathStyle}
              />
            </div>
          )}

          {testResult && (
            <div
              className={[
                'rounded-md border px-3 py-2 text-sm',
                testResult.ok
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                  : 'border-destructive/50 bg-destructive/10 text-destructive',
              ].join(' ')}
            >
              {testResult.message}
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <Button onClick={handleSave} disabled={saving || !provider}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
            <Button variant="outline" onClick={handleTest} disabled={testing || !config?.configured}>
              {testing ? 'Testing...' : 'Test connection'}
            </Button>
            {config?.source === 'db' && (
              <Button variant="outline" onClick={handleReset}>
                Reset to env defaults
              </Button>
            )}
          </div>
        </div>
      )}
    </SectionCard>
  );
}

export default StorageTab;
