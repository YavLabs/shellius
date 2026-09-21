import { SearchX } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * The empty state a filtered list shows when nothing matches — distinct from
 * a page's plain "nothing here yet" message, which stays the `emptyMessage`
 * string DataTable renders on its own. Any page with filterDefs passes this
 * as `emptyState` whenever `activeFilterCount > 0`, so a short list always
 * reads as "your filters are narrow" rather than "this feature is broken".
 */
function FilteredEmptyState({ onClear, message = 'No results match these filters.' }) {
  return (
    <div className="flex flex-col items-center gap-3 py-4 text-center">
      <SearchX className="h-8 w-8 text-muted-foreground/50" />
      <p className="text-sm text-muted-foreground">{message}</p>
      {onClear && (
        <Button variant="outline" size="sm" onClick={onClear}>
          Clear filters
        </Button>
      )}
    </div>
  );
}

export default FilteredEmptyState;
