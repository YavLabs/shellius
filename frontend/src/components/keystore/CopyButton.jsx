import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

function CopyButton({ text, className }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      title="Copy to clipboard"
      className={cn(
        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-input bg-background text-muted-foreground hover:bg-accent hover:text-foreground transition-colors',
        className
      )}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

export default CopyButton;
