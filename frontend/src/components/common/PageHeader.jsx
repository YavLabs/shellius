import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import HelpButton from './HelpButton';
import { useAdminFrame } from '@/components/admin/AdminFrameContext';

/**
 * Page title row. `back` ({ to, label }) adds a small "<- label" link above
 * the title. Inside Administration it renders as the section card's header
 * (the card supplies the padding this header bleeds into).
 */
function PageHeader({ icon: Icon, title, subtitle, children, helpKey, back }) {
  const backLink = back && (
    <Link to={back.to} className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-3.5 w-3.5" /> {back.label}
    </Link>
  );

  // Inside Administration the page title is "Administration"; a section's
  // own header becomes the header of its card (full-bleed, divider below).
  const inFrame = useAdminFrame();
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
        {children}
        {helpKey && <HelpButton helpKey={helpKey} />}
      </div>
    </div>
  );
}

export default PageHeader;
