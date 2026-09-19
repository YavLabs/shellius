import { Link } from 'react-router-dom';
import { FileQuestion } from 'lucide-react';
import AuthShell from '@/components/auth/AuthShell';

function NotFound() {
  return (
    <AuthShell className="px-6">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-6">
        <FileQuestion className="h-8 w-8 text-muted-foreground" />
      </div>
      <h1 className="text-4xl font-bold tracking-tight text-foreground">404</h1>
      <p className="mt-2 text-lg font-medium text-foreground">Page not found</p>
      <p className="mt-1 text-sm text-muted-foreground">
        The page you are looking for does not exist or has been moved.
      </p>
      <Link
        to="/"
        className="mt-6 flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
      >
        Go back home
      </Link>
    </AuthShell>
  );
}

export default NotFound;
