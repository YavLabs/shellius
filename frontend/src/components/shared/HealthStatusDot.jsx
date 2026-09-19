import { cn } from '@/lib/utils';

export const HEALTH_COLORS = {
  healthy: 'bg-emerald-500',
  unhealthy: 'bg-red-500',
  unknown: 'bg-muted-foreground/60',
  maintenance: 'bg-yellow-500',
};

export const HEALTH_LABELS = {
  healthy: 'Healthy',
  unhealthy: 'Unhealthy',
  unknown: 'Unknown',
  maintenance: 'Maintenance',
};

function HealthStatusDot({ status, showLabel = false, className }) {
  const color = HEALTH_COLORS[status] || HEALTH_COLORS.unknown;
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span className={cn('inline-block h-2 w-2 rounded-full', color)} />
      {showLabel && (
        <span className="text-xs text-muted-foreground">
          {HEALTH_LABELS[status] || 'Unknown'}
        </span>
      )}
    </span>
  );
}

export default HealthStatusDot;
