import { cn } from '@/lib/utils';

const styles = {
  ACTIVE:
    'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  REVOKED:
    'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  EXPIRED:
    'bg-gray-100 text-gray-700 dark:bg-gray-800/60 dark:text-gray-300',
};

function CertStatusBadge({ status, className }) {
  const key = (status || '').toUpperCase();
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        styles[key] || styles.EXPIRED,
        className
      )}
    >
      {key || 'UNKNOWN'}
    </span>
  );
}

export default CertStatusBadge;
