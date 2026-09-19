import { Button } from '@/components/ui/button';
import BottomSheet from './BottomSheet';

/**
 * FilterSheet — the bottom sheet a mobile list's "Filters" button opens, on
 * the shared BottomSheet chrome. The filter controls are the page's own
 * `filters` slot, stacked full width. Filters apply as they change (same as
 * desktop), so "Done" just closes.
 */
export default function FilterSheet({ open, onClose, title = 'Filters', activeCount = 0, onReset, children }) {
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      closeLabel="Close filters"
      title={
        <>
          {title}
          {activeCount > 0 && (
            <span className="ml-2 rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">{activeCount}</span>
          )}
        </>
      }
      // Controls stack full width; the page's fixed desktop widths are overridden.
      bodyClassName="flex flex-col gap-3 pb-4 [&>*]:!w-full [&>*]:!max-w-none [&_button.field-soft]:h-11"
      footer={
        <div className="flex gap-2">
          {onReset && (
            <Button variant="outline" className="h-11 flex-1" onClick={onReset} disabled={activeCount === 0}>
              Reset
            </Button>
          )}
          <Button className="h-11 flex-1" onClick={onClose}>
            Done
          </Button>
        </div>
      }
    >
      {children}
    </BottomSheet>
  );
}
