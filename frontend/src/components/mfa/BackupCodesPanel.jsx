import { useState } from 'react';
import { Copy, Check, Download } from 'lucide-react';

function downloadCodes(codes) {
  const blob = new Blob([codes.join('\n') + '\n'], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'shellius-backup-codes.txt';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * BackupCodesPanel — shared "here are your one-time recovery codes" display,
 * used right after enrollment/regeneration. Copy-all and download-as-.txt so
 * people can actually save them somewhere durable.
 */
export default function BackupCodesPanel({ codes, title }) {
  const [copied, setCopied] = useState(false);

  if (!codes || codes.length === 0) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
      <p className="mb-2 text-xs font-medium text-amber-700 dark:text-amber-300">
        {title || 'Save these backup codes somewhere safe — each works once if you lose your device.'}
      </p>
      <div className="grid grid-cols-2 gap-1 font-mono text-xs text-foreground">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} Copy all
        </button>
        <button
          type="button"
          onClick={() => downloadCodes(codes)}
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <Download className="h-3 w-3" /> Download .txt
        </button>
      </div>
    </div>
  );
}
