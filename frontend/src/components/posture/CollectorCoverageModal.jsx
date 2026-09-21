import { useCallback, useEffect, useState } from 'react';
import { Download, Radar, ShieldCheck } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import Skeleton from '@/components/ui/Skeleton';
import InstallPlanGroups from '@/components/posture/InstallPlanGroups';
import { planBulkInstall } from '@/services/serverService';
import { groupPlan } from '@/lib/installPlan';

/**
 * CollectorCoverageModal — the list behind "reporting X of Y".
 *
 * Two versions of this were wrong before. First it was a dead statistic: it
 * told you 3 of 31 servers report, with no way to find the other 28. Then it
 * was a flat list of those 28, which mixed hosts needing a password with
 * Windows boxes that can never run the collector — and offered "Install on
 * all of them", which handed every one of them to a planner that
 * immediately refused half. The number you clicked was never the number
 * that ran, and part of the gap could not be closed by any action at all.
 *
 * It now reads the same plan the installer runs from, so "Ready to install:
 * 12" and "Install on 12 hosts" are the same twelve by construction.
 */
function CollectorCoverageModal({ open, onClose, onInstall, onInstallAll, canInstall }) {
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // Every server in scope, not a page of them: this is the one view
      // whose job is to account for the whole fleet.
      setPlan(await planBulkInstall({ serverIds: [], mode: 'posture' }));
    } catch (err) {
      setError(
        err?.response?.data?.error?.message || err.message || 'Could not load collector coverage.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const ready = groupPlan(plan).find((g) => g.key === 'ready')?.rows || [];
  const counts = plan?.counts;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Collector coverage"
      size="lg"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {ready.length > 0
              ? `${ready.length} host${ready.length === 1 ? '' : 's'} ready to install`
              : 'Nothing is waiting to be installed.'}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
            {canInstall && onInstallAll && ready.length > 0 && (
              <Button onClick={() => onInstallAll(ready.map((r) => r.id))}>
                <Download className="mr-2 h-4 w-4" />
                Install on {ready.length} host{ready.length === 1 ? '' : 's'}
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Posture only sees hosts running the collector. Hosts that cannot run it at all are listed
          separately and left out of the coverage count — they are a correct end state, not a gap.
        </p>

        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-lg" />
            ))}
          </div>
        ) : (
          <>
            {counts && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="font-medium text-foreground tabular-nums">{counts.total}</span>
                  host{counts.total === 1 ? '' : 's'} in scope
                </span>
                {counts.usingCertificate > 0 && (
                  <span>
                    <span className="font-medium text-foreground tabular-nums">
                      {counts.usingCertificate}
                    </span>{' '}
                    reachable by certificate, no stored secret needed
                  </span>
                )}
              </div>
            )}

            {plan && <InstallPlanGroups plan={plan} onInstallHost={canInstall ? onInstall : undefined} />}

            {plan && counts?.total === 0 && (
              <p className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-border px-3 py-8 text-sm text-muted-foreground">
                <Radar className="h-4 w-4" aria-hidden="true" />
                No servers in scope yet.
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

export default CollectorCoverageModal;
