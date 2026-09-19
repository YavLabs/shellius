import { Link } from 'react-router-dom';
import { ArrowLeft, ChevronDown } from 'lucide-react';
import HelpButton from './HelpButton';
import MobilePageHeader from '@/components/mobile/MobilePageHeader';
import { useAdminFrame } from '@/components/admin/AdminFrameContext';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import useIsMobile from '@/hooks/useIsMobile';
import { cn } from '@/lib/utils';
import { visibleActions } from '@/lib/pageHeaderActions';

/** Desktop rendering of one `actions` entry (see lib/pageHeaderActions.js). */
function DesktopAction({ action: a }) {
  if (a.desktop !== undefined) return a.desktop;
  const Icon = a.icon;
  if (a.items) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant={a.variant || 'outline'} size={a.size} disabled={a.disabled}>
            {Icon && <Icon className="mr-2 h-4 w-4" />}
            {a.label}
            <ChevronDown className="ml-2 h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          {a.items
            .filter((i) => i && !i.hidden)
            .map((i) => (
              <DropdownMenuItem key={i.key} onClick={i.onClick} disabled={i.disabled}>
                {i.label}
              </DropdownMenuItem>
            ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  return (
    <Button variant={a.variant} size={a.size} onClick={a.onClick} disabled={a.disabled}>
      {Icon && <Icon className={cn('mr-2 h-4 w-4', a.spin && 'animate-spin')} />}
      {a.label}
    </Button>
  );
}

/**
 * Page title row. `back` ({ to, label }) adds a small "<- label" link above
 * the title. Inside Administration it renders as the section card's header
 * (the card supplies the padding this header bleeds into).
 *
 * Actions: pass `actions` (see lib/pageHeaderActions.js) so the header can
 * lay them out for phones too — one primary button, the rest in a "⋯"
 * menu. `children` still render next to them (on phones, under the title).
 * `compactPrimary` puts the primary action at the end of the title row on
 * phones instead of full-width under the subtitle.
 */
function PageHeader({ icon: Icon, title, subtitle, children, helpKey, back, actions, compactPrimary = false }) {
  const inFrame = useAdminFrame();
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <MobilePageHeader
        icon={Icon}
        title={title}
        subtitle={subtitle}
        helpKey={helpKey}
        back={back}
        actions={actions}
        compactPrimary={compactPrimary}
        level={inFrame ? 2 : 1}
      >
        {children}
      </MobilePageHeader>
    );
  }

  const backLink = back && (
    <Link to={back.to} className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-3.5 w-3.5" /> {back.label}
    </Link>
  );
  const actionNodes = visibleActions(actions).map((a) => <DesktopAction key={a.key} action={a} />);

  // Inside Administration the page title is "Administration"; a section's
  // own header becomes the header of its card (full-bleed, divider below).
  if (inFrame) {
    return (
      <div className="-mx-4 -mt-4 flex flex-col gap-3 border-b border-border px-4 py-4 sm:-mx-5 sm:-mt-5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="min-w-0 space-y-0.5">
          {backLink}
          <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
            {Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
            <span className="min-w-0 break-words">{title}</span>
          </h2>
          {subtitle && <div className="text-sm text-muted-foreground">{subtitle}</div>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actionNodes}
          {children}
          {helpKey && <HelpButton helpKey={helpKey} />}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-1">
        {backLink}
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          {Icon && <Icon className="h-6 w-6 shrink-0 text-primary" aria-hidden="true" />}
          {title}
        </h1>
        {subtitle && <div className="text-sm text-muted-foreground">{subtitle}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {actionNodes}
        {children}
        {helpKey && <HelpButton helpKey={helpKey} />}
      </div>
    </div>
  );
}

export default PageHeader;
