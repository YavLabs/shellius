import { Link } from 'react-router-dom';
import { ChevronLeft, MoreHorizontal } from 'lucide-react';
import HelpButton from '@/components/common/HelpButton';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { overflowEntries, splitActions } from '@/lib/pageHeaderActions';
import { useRegisterPageActions } from '@/context/PageActionsContext';

const ICON_BTN =
  'flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function ActionIcon({ icon: Icon, spin, className }) {
  if (!Icon) return null;
  return <Icon className={cn('h-4 w-4', spin && 'animate-spin', className)} aria-hidden="true" />;
}

/** "⋯" overflow menu with every secondary action. */
function OverflowMenu({ entries }) {
  if (entries.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(ICON_BTN, '-mr-2')} aria-label="More actions">
          <MoreHorizontal className="h-5 w-5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {entries.map((e, idx) =>
          e.type === 'label' ? (
            <div key={e.key}>
              {idx > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">{e.label}</DropdownMenuLabel>
            </div>
          ) : (
            <DropdownMenuItem
              key={e.key}
              onSelect={() => e.onClick?.()}
              disabled={e.disabled}
              className={cn(
                'min-h-11 gap-2',
                e.destructive && 'text-destructive focus:bg-destructive/10 focus:text-destructive'
              )}
            >
              <ActionIcon icon={e.icon} spin={e.spin} />
              <span className="flex-1">{e.label}</span>
              {e.checked && <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-label="(current)" />}
            </DropdownMenuItem>
          )
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PrimaryButton({ action: a, compact }) {
  return (
    <Button
      variant={a.variant}
      onClick={a.onClick}
      disabled={a.disabled}
      className={compact ? 'h-10 shrink-0 px-3' : 'h-11 w-full'}
    >
      <ActionIcon icon={a.icon} spin={a.spin} className={compact ? 'mr-1.5' : 'mr-2'} />
      {a.label}
    </Button>
  );
}

/**
 * Phone layout of a page header (docs/plans/1.5.1-mobile.md §2):
 *   row 1  [‹ back] icon + title (one line, truncates) … [compact primary] [?] [⋯]
 *   row 2  subtitle / meta line (up to two lines, muted)
 *   row 3  primary action, full width — or, inside the app layout, in the
 *          bottom navigation's "+" sheet (context/PageActionsContext.jsx)
 * Used by PageHeader on phones and directly by detail pages whose desktop
 * header is bespoke. `primaryNode` replaces the primary action button with a
 * custom control (e.g. the server Connect / Request access button).
 */
function MobilePageHeader({
  icon: Icon,
  title,
  subtitle,
  helpKey,
  back,
  actions,
  compactPrimary = false,
  primaryNode,
  level = 1,
  children,
}) {
  const { primary, secondary } = splitActions(actions);
  // The primary (create) action goes to the bottom navigation's "+" sheet
  // instead of a full-width button here — unless the page shows a bespoke
  // control (primaryNode, e.g. Connect) or there's no navigation to take it.
  const movable = primary && !primaryNode && typeof primary.onClick === 'function' ? [primary] : [];
  const inPlusSheet = useRegisterPageActions(movable, movable.length > 0);
  const entries = overflowEntries(secondary);
  const Heading = level === 1 ? 'h1' : 'h2';
  const backLabel = back?.label || 'Back';

  const backButton = back ? (
    back.to ? (
      <Link to={back.to} className={cn(ICON_BTN, '-ml-3')} aria-label={backLabel} title={backLabel}>
        <ChevronLeft className="h-5 w-5" />
      </Link>
    ) : (
      <button type="button" onClick={back.onClick} className={cn(ICON_BTN, '-ml-3')} aria-label={backLabel} title={backLabel}>
        <ChevronLeft className="h-5 w-5" />
      </button>
    )
  ) : null;

  const inFrame = level !== 1;

  return (
    <div
      className={cn(
        'space-y-1.5',
        // Inside an Administration card: bleed to the card edges like the desktop header.
        inFrame && '-mx-4 -mt-4 border-b border-border px-4 pb-4 pt-2'
      )}
      data-mobile-header=""
    >
      {/* Title row: the 44px icon buttons overlap the row's padding (-my-1) so
          they don't push the subtitle away from the title. */}
      <div className="flex min-h-9 items-center gap-1 [&>*:not(.min-w-0)]:-my-1">
        {backButton}
        <div className="min-w-0 flex-1">
          <Heading
            className={cn(
              'flex min-w-0 items-center gap-2 font-bold tracking-tight',
              level === 1 ? 'text-xl' : 'text-base font-semibold text-foreground'
            )}
          >
            {Icon && (
              <Icon
                className={cn('shrink-0', level === 1 ? 'h-5 w-5 text-primary' : 'h-4 w-4 text-muted-foreground')}
                aria-hidden="true"
              />
            )}
            <span className="min-w-0 truncate">{title}</span>
          </Heading>
        </div>
        {compactPrimary && primary && !primaryNode && !inPlusSheet && <PrimaryButton action={primary} compact />}
        {helpKey && (
          <span className="-mr-1 shrink-0 [&>button]:h-11 [&>button]:w-11">
            <HelpButton helpKey={helpKey} />
          </span>
        )}
        <OverflowMenu entries={entries} />
      </div>
      {subtitle && <div className="line-clamp-2 text-sm leading-snug text-muted-foreground">{subtitle}</div>}
      {primaryNode ? (
        <div className="[&>*]:w-full [&_button]:h-11 [&_button]:w-full">{primaryNode}</div>
      ) : (
        primary && !compactPrimary && !inPlusSheet && <PrimaryButton action={primary} />
      )}
      {/* Pages not yet describing their buttons as `actions` keep them, wrapped. */}
      {children && !actions && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export default MobilePageHeader;
