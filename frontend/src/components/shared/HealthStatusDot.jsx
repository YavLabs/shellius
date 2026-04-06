import { cn } from '@/lib/utils';

const colors = {
  healthy: 'bg-emerald-500',
  unhealthy: 'bg-red-500',
  unknown: 'bg-zinc-400',
  maintenance: 'bg-yellow-500',
};

const labels = {
  healthy: 'Healthy',
  unhealthy: 'Unhealthy',
  unknown: 'Unknown',
  maintenance: 'Maintenance',
};

function HealthStatusDot({ status, showLabel = false, className }) {
  const color = colors[status] || colors.unknown;
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span className={cn('inline-block h-2 w-2 rounded-full', color)} />
      {showLabel && (
        <span className="text-xs text-muted-foreground">
          {labels[status] || 'Unknown'}
        </span>
      )}
    </span>
  );
}

export default HealthStatusDot;
