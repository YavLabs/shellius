import useIsMobile from '@/hooks/useIsMobile';
import { SectionTitle } from '@/components/mobile/MobileNavList';
import { cn } from '@/lib/utils';

/**
 * The heading above a group of cards on a detail page.
 *
 * Two treatments, one component. On desktop it is the quiet uppercase label
 * the section grids have always used. On a phone it is the Dashboard's
 * section title — brand bar, 15px, optional count and a "View all" slot —
 * because on a phone these stop being column headings and become the only
 * thing separating one full-width stack of cards from the next. Detail pages
 * that rolled their own uppercase label kept that desktop style at phone
 * width, so Server Details and the Dashboard disagreed about what a section
 * looks like on the same screen.
 *
 * Takes `title` or children, so existing `<SectionHeading>Status</…>` call
 * sites read naturally.
 */
function SectionHeading({ title, children, count, action, className }) {
  const isMobile = useIsMobile();
  const label = title ?? children;

  if (isMobile) {
    return <SectionTitle title={label} count={count} action={action} className={className} />;
  }

  return (
    <div className={cn('flex items-center justify-between gap-3', className)}>
      <h2 className="flex min-w-0 items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        <span className="truncate">{label}</span>
        {count !== null && count !== undefined && count !== false && (
          <span className="shrink-0 normal-case tracking-normal tabular-nums text-muted-foreground/70">
            {count}
          </span>
        )}
      </h2>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export default SectionHeading;
