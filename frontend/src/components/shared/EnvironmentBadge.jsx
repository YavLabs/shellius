import { cn } from '@/lib/utils';

const styles = {
  demo: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  dev: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  staging: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  prod: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
};

function EnvironmentBadge({ environment, className }) {
  if (!environment) return null;
  const style = styles[environment] || styles.demo;
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
        style,
        className
      )}
    >
      {environment}
    </span>
  );
}

export default EnvironmentBadge;
