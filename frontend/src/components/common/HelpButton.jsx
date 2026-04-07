import { useState } from 'react';
import { HelpCircle } from 'lucide-react';
import HelpDrawer from './HelpDrawer';

/**
 * HelpButton — small `?` icon that opens HelpDrawer for the given page.
 * Used in PageHeader's right slot when the page passes a `helpKey` prop.
 */
function HelpButton({ helpKey }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        title="What does this page do?"
        aria-label="Help"
      >
        <HelpCircle className="h-[18px] w-[18px]" />
      </button>
      <HelpDrawer open={open} onClose={() => setOpen(false)} helpKey={helpKey} />
    </>
  );
}

export default HelpButton;
