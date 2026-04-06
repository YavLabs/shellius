import { cn } from '@/lib/utils';

/**
 * Skeleton — animated placeholder for loading states.
 *
 * Usage:
 *   <Skeleton className="h-4 w-32" />
 *   <TableSkeleton rows={5} cols={6} />
 */
function Skeleton({ className }) {
  return (
    <div className={cn('animate-pulse rounded bg-muted', className)} />
  );
}

/**
 * TableSkeleton — renders `rows` skeleton rows with `cols` cells each.
 * Renders inside a <tbody> so it must be placed inside a <table>.
 *
 * Or use as a standalone block by wrapping in a <table><tbody>.
 */
function TableSkeleton({ rows = 5, cols = 5 }) {
  return Array.from({ length: rows }).map((_, i) => (
    <tr key={i} className="border-b border-border">
      {Array.from({ length: cols }).map((__, j) => (
        <td key={j} className="px-4 py-3">
          <Skeleton className="h-4 w-24" />
        </td>
      ))}
    </tr>
  ));
}

export { TableSkeleton };
export default Skeleton;
