import { cn } from '@/lib/utils';
import BottomSheet from './BottomSheet';

/**
 * ActionSheet — a list of actions in a bottom sheet (the bottom
 * navigation's centre button), on the shared BottomSheet chrome.
 *
 * groups: [{ key, label (optional heading), items: [{ key, label, icon, onSelect, emphasis }] }]
 */
function ActionSheet({ open, onClose, title, groups = [] }) {
  return (
    <BottomSheet open={open} onClose={onClose} title={title} bodyClassName="px-2 pt-2 pb-3">
        <div>
          {groups.map((group, idx) => (
            <div key={group.key} className={cn(idx > 0 && 'mt-2 border-t border-border pt-2')}>
              {group.label && (
                <p className="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                  {group.label}
                </p>
              )}
              <ul>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <li key={item.key}>
                      <button
                        type="button"
                        onClick={item.onSelect}
                        className={cn(
                          'flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-sm transition-colors active:bg-accent hover:bg-accent/60',
                          item.emphasis ? 'font-semibold text-foreground' : 'text-foreground'
                        )}
                      >
                        {Icon && (
                          <span
                            className={cn(
                              'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                              item.emphasis
                                ? 'bg-brand-gradient text-[color:var(--brand-on-gradient)]'
                                : 'bg-muted text-muted-foreground'
                            )}
                          >
                            <Icon className="h-4 w-4" aria-hidden="true" />
                          </span>
                        )}
                        <span className="flex-1 truncate">{item.label}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
    </BottomSheet>
  );
}

export default ActionSheet;
