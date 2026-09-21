import { useEffect, useMemo, useState } from 'react';
import { Download, FileJson, FileSpreadsheet, FileText, Loader2, Package } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import { getExportFields, exportPosture } from '@/services/postureService';
import { cn } from '@/lib/utils';

/**
 * ExportDialog — format, columns and (for multi-server exports) bundling.
 *
 * The file is built server-side: the findings inbox is server-paginated, so
 * exporting "what the table has" would quietly ship one page instead of the
 * filter the user is looking at. The dialog therefore describes an intent
 * and the API answers with a file.
 */

const FORMATS = [
  {
    key: 'csv',
    icon: FileSpreadsheet,
    label: 'CSV',
    blurb: 'One row per record. Opens in Excel, Sheets and anything that reads a spreadsheet.',
  },
  {
    key: 'json',
    icon: FileJson,
    label: 'JSON',
    blurb: 'Structured records for tooling, ticket automation or a follow-up script.',
  },
  {
    key: 'pdf',
    icon: FileText,
    label: 'PDF',
    blurb: 'A formatted report to read or attach. Leads with a summary rather than a wide grid.',
  },
];

function Choice({ icon: Icon, title, blurb, selected, onSelect }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors',
        selected ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40 hover:bg-accent/40'
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border',
          selected ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border text-muted-foreground'
        )}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{blurb}</span>
      </span>
    </button>
  );
}

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {'findings'|'listeners'} props.dataset
 * @param {object} props.filters      passed through to the API unchanged
 * @param {number} [props.serverCount] >1 enables the bundle choice
 * @param {string} [props.scopeLabel]  human description of what will be exported
 * @param {() => void} props.onClose
 */
function ExportDialog({ open, dataset, filters = {}, serverCount = 1, scopeLabel, onClose }) {
  const [catalogue, setCatalogue] = useState(null);
  const [format, setFormat] = useState('csv');
  const [bundle, setBundle] = useState('single');
  const [selected, setSelected] = useState([]);
  const [allFields, setAllFields] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!open) return;
    setError('');
    setResult(null);
    setBusy(false);
    getExportFields()
      .then((data) => {
        setCatalogue(data);
        setSelected((data?.[dataset] || []).map((f) => f.key));
      })
      .catch((err) => setError(err?.response?.data?.error?.message || 'Could not load the field list.'));
  }, [open, dataset]);

  const fields = useMemo(() => catalogue?.[dataset] || [], [catalogue, dataset]);
  const multi = serverCount > 1;

  const toggle = (key) =>
    setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      const meta = await exportPosture({
        dataset,
        format,
        bundle: multi ? bundle : 'single',
        // An empty array means "everything" to the API, which keeps a saved
        // export working when new fields are added later.
        fields: allFields ? [] : selected,
        filters,
      });
      setResult(meta);
    } catch (err) {
      setError(err.message || 'Export failed.');
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = !busy && (allFields || selected.length > 0);

  const footer = (
    <div className="flex items-center justify-end gap-2" data-sheet-footer>
      <Button variant="outline" onClick={onClose}>
        {result ? 'Done' : 'Cancel'}
      </Button>
      <Button onClick={run} disabled={!canSubmit}>
        {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
        {busy ? 'Preparing…' : 'Export'}
      </Button>
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={dataset === 'findings' ? 'Export findings' : 'Export listeners'}
      size="lg"
      footer={footer}
    >
      <div className="space-y-5">
        {scopeLabel && (
          <p className="text-xs text-muted-foreground">
            Exporting <span className="font-medium text-foreground">{scopeLabel}</span>. Only records
            you have access to are included.
          </p>
        )}

        {error && (
          <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {result && (
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-200">
            Downloaded <span className="font-mono text-xs">{result.filename}</span>
            {result.rows !== null && (
              <>
                {' '}
                — {result.rows} record{result.rows === 1 ? '' : 's'}
                {result.servers > 1 ? ` across ${result.servers} servers` : ''}.
              </>
            )}
            {result.rows === 0 && ' Nothing matched the current filters.'}
          </div>
        )}

        <section className="space-y-2">
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">Format</h4>
          {FORMATS.map((f) => (
            <Choice
              key={f.key}
              icon={f.icon}
              title={f.label}
              blurb={f.blurb}
              selected={format === f.key}
              onSelect={() => setFormat(f.key)}
            />
          ))}
        </section>

        {multi && (
          <section className="space-y-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              {serverCount} servers selected
            </h4>
            <Choice
              icon={FileSpreadsheet}
              title="One file"
              blurb="Every server in a single file, with a server column to tell them apart. Best for sorting and filtering across the fleet."
              selected={bundle === 'single'}
              onSelect={() => setBundle('single')}
            />
            <Choice
              icon={Package}
              title="ZIP, one file per server"
              blurb="An archive with a separate file per server, named after the host. Best for filing per customer or attaching to per-host tickets."
              selected={bundle === 'zip'}
              onSelect={() => setBundle('zip')}
            />
          </section>
        )}

        <section className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              Columns
            </h4>
            {!allFields && (
              <div className="flex items-center gap-2 text-xs">
                <button type="button" className="text-primary hover:underline" onClick={() => setSelected(fields.map((f) => f.key))}>
                  All
                </button>
                <button type="button" className="text-primary hover:underline" onClick={() => setSelected([])}>
                  None
                </button>
              </div>
            )}
          </div>

          <label className="flex items-start gap-2 rounded-lg border border-border p-3">
            <input
              type="checkbox"
              checked={allFields}
              onChange={(e) => setAllFields(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
            />
            <span className="min-w-0">
              <span className="block text-sm text-foreground">Every field</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Includes fields added in future releases, so a repeat of this export stays complete.
              </span>
            </span>
          </label>

          {!allFields && (
            <div className="grid max-h-56 grid-cols-1 gap-1 overflow-y-auto rounded-lg border border-border p-2 sm:grid-cols-2">
              {fields.map((f) => (
                <label
                  key={f.key}
                  className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-foreground hover:bg-accent/50"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(f.key)}
                    onChange={() => toggle(f.key)}
                    className="h-4 w-4 rounded border-input accent-primary"
                  />
                  <span className="truncate">{f.label}</span>
                </label>
              ))}
            </div>
          )}
          {!allFields && selected.length === 0 && (
            <p className="text-xs text-destructive">Pick at least one column.</p>
          )}
        </section>
      </div>
    </Modal>
  );
}

export default ExportDialog;
