import { useNavigate } from 'react-router-dom';
import { ChevronRight, Info, Radar, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PostureTile, PostureTileGrid } from '@/components/posture/PostureTiles';
import { SectionTitle, ViewAllLink } from '@/components/mobile/MobileNavList';
import useIsMobile from '@/hooks/useIsMobile';

/**
 * Security posture for one customer, as a dashboard widget.
 *
 * It used to be a bare section label with two plain text links crowded into
 * the corner — "Install collectors" and "Open in Posture", the same colour,
 * the same weight, side by side with nothing to say which one navigates and
 * which one does something to your fleet. On the same page, the Servers
 * section signalled its action with a real button, so one page had two
 * conventions for "the thing you can do here".
 *
 * Now it follows the Dashboard's widget shape: a titled card with one
 * navigation affordance ("View all ›") in the header, and actions attached
 * to the thing they act on.
 *
 * The install button lives inside the coverage callout rather than the
 * header, because it is the remedy for exactly that warning — and when
 * coverage is complete the callout and the button both disappear, instead of
 * a permanent button competing with a link it does not resemble.
 */

const TILES = [
  { key: 'critical', label: 'Critical', icon: ShieldAlert, tint: 'text-red-500' },
  { key: 'high', label: 'High', icon: ShieldAlert, tint: 'text-orange-500' },
  { key: 'medium', label: 'Medium', icon: Radar, tint: 'text-amber-500' },
  { key: 'low', label: 'Low', icon: Info, tint: 'text-sky-500' },
];

/** The amber "your coverage has holes" panel, with its own remedy attached. */
function CoverageCallout({ children, canOnboard, onInstall, label }) {
  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
      <Radar
        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400"
        aria-hidden="true"
      />
      <p className="min-w-0 flex-1 text-xs leading-relaxed text-foreground">{children}</p>
      {canOnboard && (
        <Button variant="outline" size="sm" className="h-8 shrink-0" onClick={onInstall}>
          {label}
        </Button>
      )}
    </div>
  );
}

function CustomerPostureWidget({ customerId, posture, canOnboard, onInstall }) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  if (!posture) return null;

  const { servers, findings } = posture;
  const postureHref = `/posture?customerId=${customerId}`;
  // "No collector anywhere" is notInstalled === total, NOT reporting === 0.
  // A stale host still has a collector and still has findings worth showing.
  const noCoverageAtAll = servers.total > 0 && servers.notInstalled === servers.total;
  const allClear =
    !noCoverageAtAll && servers.notInstalled === 0 && servers.stale === 0;

  return (
    <div className="flex flex-col rounded-lg border border-border bg-card p-5 max-md:rounded-none max-md:border-0 max-md:bg-transparent max-md:p-0">
      {isMobile ? (
        <SectionTitle title="Security posture" action={<ViewAllLink to={postureHref} />} />
      ) : (
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Security posture</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Exposure findings across this customer&rsquo;s servers
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate(postureHref)}
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-[hsl(var(--brand))] hover:bg-accent"
          >
            View all <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      <div className="space-y-3">
        {noCoverageAtAll ? (
          <CoverageCallout
            canOnboard={canOnboard}
            onInstall={onInstall}
            label="Install collectors"
          >
            No host for this customer is running the posture collector yet, so there is nothing to
            report.{' '}
            {!canOnboard && (
              <span className="text-muted-foreground">
                Someone with onboarding rights can install it.
              </span>
            )}
          </CoverageCallout>
        ) : (
          <>
            <PostureTileGrid className="lg:grid-cols-5">
              {TILES.map((t) => (
                <PostureTile
                  key={t.key}
                  inset
                  icon={t.icon}
                  tint={t.tint}
                  label={t.label}
                  value={findings[t.key] ?? 0}
                  to={`${postureHref}&severity=${t.key.toUpperCase()}`}
                />
              ))}
              <PostureTile
                inset
                icon={Radar}
                label="Collector installed"
                value={servers.reporting + servers.stale}
                suffix={
                  <span className="ml-1 text-sm font-normal text-muted-foreground">
                    of {servers.total}
                  </span>
                }
              />
            </PostureTileGrid>

            {allClear ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <ShieldCheck
                  className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                  aria-hidden="true"
                />
                Every server that can run the collector is reporting.
              </p>
            ) : (
              <CoverageCallout
                canOnboard={canOnboard}
                onInstall={onInstall}
                label={servers.notInstalled > 0 ? 'Install collectors' : 'Reinstall'}
              >
                {servers.notInstalled > 0 && (
                  <>
                    {servers.notInstalled} of this customer&rsquo;s servers have no collector, so
                    their exposure is <span className="font-medium">unknown, not clean</span>.
                  </>
                )}
                {servers.stale > 0 && (
                  <>
                    {servers.notInstalled > 0 ? ' ' : ''}
                    {servers.stale} stopped reporting — their findings are held at the last known
                    state, not cleared.
                  </>
                )}
              </CoverageCallout>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default CustomerPostureWidget;
