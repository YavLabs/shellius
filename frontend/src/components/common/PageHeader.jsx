import HelpButton from './HelpButton';

function PageHeader({ icon: Icon, title, subtitle, children, helpKey }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          {Icon && <Icon className="h-6 w-6 shrink-0 text-primary" aria-hidden="true" />}
          {title}
        </h1>
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {children}
        {helpKey && <HelpButton helpKey={helpKey} />}
      </div>
    </div>
  );
}

export default PageHeader;
