import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Upload,
  FileUp,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Download,
  RotateCcw,
} from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import {
  uploadImport,
  getImportJob,
  setImportDecisions,
  commitImport,
  downloadTemplate,
} from '@/services/importService';
import SearchableSelect from '@/components/ui/SearchableSelect';

const ENTITY_TYPES = [
  { value: '', label: 'Auto-detect (JSON object / ZIP)' },
  { value: 'customers', label: 'Customers' },
  { value: 'servers', label: 'Servers' },
  { value: 'users', label: 'Users' },
  { value: 'groups', label: 'Groups' },
  { value: 'policies', label: 'Policies' },
  { value: 'memberships', label: 'Memberships' },
];

const ACTION_BADGE = {
  create: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  conflict: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  error: 'bg-destructive/15 text-destructive',
  skip: 'bg-muted text-muted-foreground',
};

const STATUS_BADGE = {
  imported: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  done: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  skipped: 'bg-muted text-muted-foreground',
  failed: 'bg-destructive/15 text-destructive',
  pending: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  staged: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  running: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
};

const ONBOARDING_LABEL = {
  done: 'onboarded',
  failed: 'failed — onboard later',
  running: 'running',
  pending: 'queued',
  staged: 'queued',
};

function Badge({ cls, children }) {
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${cls}`}>{children}</span>
  );
}

function BulkImport() {
  const [step, setStep] = useState('upload'); // upload | review | done
  const [type, setType] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [job, setJob] = useState(null); // { job, rows, onboarding }
  const fileRef = useRef(null);
  const pollRef = useRef(null);

  const refresh = useCallback(async (id) => {
    const data = await getImportJob(id);
    setJob(data);
    return data;
  }, []);

  // Poll while onboarding is in progress.
  useEffect(() => {
    const status = job?.job?.status;
    if (status === 'onboarding') {
      pollRef.current = setInterval(() => {
        refresh(job.job.id).catch(() => {});
      }, 3000);
      return () => clearInterval(pollRef.current);
    }
    if (pollRef.current) clearInterval(pollRef.current);
  }, [job?.job?.status, job?.job?.id, refresh]);

  const handleUpload = async () => {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const { jobId } = await uploadImport(file, type);
      await refresh(jobId);
      setStep('review');
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message || 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  const applyBulk = async (decision) => {
    setBusy(true);
    try {
      await setImportDecisions(job.job.id, decision, { applyAll: true });
      await refresh(job.job.id);
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message);
    } finally {
      setBusy(false);
    }
  };

  const setRowDecision = async (rowId, decision) => {
    try {
      await setImportDecisions(job.job.id, decision, { rowIds: [rowId] });
      await refresh(job.job.id);
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message);
    }
  };

  const handleCommit = async () => {
    setBusy(true);
    setError('');
    try {
      await commitImport(job.job.id);
      await refresh(job.job.id);
      setStep('done');
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message || 'Commit failed');
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setStep('upload');
    setFile(null);
    setJob(null);
    setError('');
    setType('');
  };

  const rows = job?.rows || [];
  const conflicts = rows.filter((r) => r.action === 'conflict');
  const errors = rows.filter((r) => r.action === 'error');
  const summary = job?.job?.summary || {};

  return (
    <div className="space-y-6 p-6">
      <PageHeader icon={Upload} title="Bulk Import" subtitle="Import customers, servers, users, groups and policies from CSV, JSON, or a ZIP package." />

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Step: Upload */}
      {step === 'upload' && (
        <div className="rounded-lg border border-border bg-card p-6 space-y-5 w-full">
          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">File type</label>
            <SearchableSelect
              className="w-full"
              value={type}
              onChange={(v) => setType(v)}
              searchable={false}
              clearable={false}
              options={ENTITY_TYPES.map((t) => ({ value: t.value, label: t.label }))}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Pick the entity for a single CSV. JSON objects ({'{ customers: [...], servers: [...] }'})
              and ZIP packages auto-detect.
            </p>
          </div>

          <div
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (e.dataTransfer.files?.[0]) setFile(e.dataTransfer.files[0]);
            }}
            className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed border-input py-10 text-center hover:bg-accent/40"
          >
            <FileUp className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-foreground">{file ? file.name : 'Drop a CSV / JSON / ZIP here, or click to browse'}</p>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.json,.zip"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={handleUpload} disabled={!file || busy}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
              Upload &amp; preview
            </Button>
            <span className="text-xs text-muted-foreground">Templates:</span>
            {['customers', 'servers', 'users', 'groups', 'policies', 'memberships'].map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => downloadTemplate(e).catch((err) => setError(err?.response?.data?.error?.message || err.message || 'Download failed'))}
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <Download className="h-3 w-3" />
                {e}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Step: Review */}
      {step === 'review' && job && (
        <div className="space-y-5">
          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {Object.entries(summary)
              .filter(([k]) => k !== 'warnings' && k !== 'result')
              .map(([entity, c]) => (
                <div key={entity} className="rounded-lg border border-border bg-card p-3">
                  <p className="text-xs font-medium capitalize text-muted-foreground">{entity}</p>
                  <p className="mt-1 text-lg font-semibold text-foreground">{c.total}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {c.create || 0} new · {c.conflict || 0} dup · {c.error || 0} err
                  </p>
                </div>
              ))}
          </div>

          {summary.warnings?.length > 0 && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
              {summary.warnings.join(' ')}
            </div>
          )}

          {/* Conflict bulk controls */}
          {conflicts.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              <span className="text-sm text-foreground">{conflicts.length} duplicate(s) found.</span>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => applyBulk('overwrite')}>
                Overwrite all
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => applyBulk('skip')}>
                Skip all
              </Button>
            </div>
          )}

          {/* Rows table */}
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Entity</th>
                  <th className="px-3 py-2 font-medium">Identifier</th>
                  <th className="px-3 py-2 font-medium">Action</th>
                  <th className="px-3 py-2 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-sm text-muted-foreground">
                      No rows were parsed. For a single CSV, pick the matching{' '}
                      <span className="font-medium text-foreground">File type</span> above and
                      re-upload — “Auto-detect” only works for JSON objects and ZIP packages.
                    </td>
                  </tr>
                )}
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="px-3 py-2 capitalize text-foreground">{r.entity}</td>
                    <td className="px-3 py-2 font-mono text-xs text-foreground">
                      {r.raw?.name || r.raw?.hostname || r.raw?.email || r.raw?.group || '—'}
                    </td>
                    <td className="px-3 py-2">
                      <Badge cls={ACTION_BADGE[r.action] || 'bg-muted'}>
                        {r.action === 'conflict' ? `conflict → ${r.decision}` : r.action}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {r.action === 'error' && r.error}
                      {r.action === 'create' && r.conflictReason}
                      {r.action === 'conflict' && (
                        <span className="flex items-center gap-2">
                          {r.conflictReason}
                          <button
                            className="text-primary hover:underline"
                            onClick={() => setRowDecision(r.id, r.decision === 'overwrite' ? 'skip' : 'overwrite')}
                          >
                            {r.decision === 'overwrite' ? 'switch to skip' : 'switch to overwrite'}
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-2">
            <Button onClick={handleCommit} disabled={busy || rows.length === errors.length}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
              Commit import
            </Button>
            <Button variant="outline" onClick={reset} disabled={busy}>
              <RotateCcw className="mr-2 h-4 w-4" />
              Start over
            </Button>
            {errors.length > 0 && (
              <span className="text-xs text-destructive">{errors.length} row(s) have errors and will be skipped.</span>
            )}
          </div>
        </div>
      )}

      {/* Step: Done / onboarding */}
      {step === 'done' && job && (
        <div className="space-y-5">
          <div className="rounded-lg border border-border bg-card p-5">
            <div className="flex items-center gap-2">
              {job.job.status === 'onboarding' ? (
                <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
              ) : (
                <CheckCircle2 className="h-5 w-5 text-emerald-500" />
              )}
              <p className="font-medium text-foreground">
                {job.job.status === 'onboarding' ? 'Import committed — onboarding servers…' : 'Import complete'}
              </p>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {(job.job.summary?.result &&
                `${job.job.summary.result.imported} imported · ${job.job.summary.result.skipped} skipped · ${job.job.summary.result.failed} failed`) ||
                ''}
            </p>
          </div>

          {job.onboarding?.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Server</th>
                    <th className="px-3 py-2 font-medium">Onboarding</th>
                    <th className="px-3 py-2 font-medium">Attempts</th>
                  </tr>
                </thead>
                <tbody>
                  {job.onboarding.map((o) => (
                    <tr key={o.id} className="border-t border-border">
                      <td className="px-3 py-2 font-mono text-xs text-foreground">{o.serverRef}</td>
                      <td className="px-3 py-2">
                        <Badge cls={STATUS_BADGE[o.status] || 'bg-muted'}>{ONBOARDING_LABEL[o.status] || o.status}</Badge>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{o.attempts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <Button variant="outline" onClick={reset}>
            <Upload className="mr-2 h-4 w-4" />
            New import
          </Button>
        </div>
      )}
    </div>
  );
}

export default BulkImport;
