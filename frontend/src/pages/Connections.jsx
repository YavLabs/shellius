import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Cable } from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import { RecentConnections } from '@/components/dashboard/RecentConnectionsWidget';

/**
 * Connections — full view behind the dashboard widget's "View all": every
 * active session of yours plus recent server and Quick Connect connections,
 * with search, a type filter and a 7/30-day range. Same rows and actions
 * as the widget (components/dashboard/RecentConnectionsWidget.jsx).
 */
function Connections() {
  const { hash } = useLocation();

  // "View all" links land on #active / #recent: scroll there once rendered.
  useEffect(() => {
    if (!hash) return undefined;
    const t = setTimeout(() => document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 400);
    return () => clearTimeout(t);
  }, [hash]);

  return (
    <div className="space-y-6 p-6">
      <PageHeader icon={Cable} title="Recent connections" subtitle="Your active sessions, and the servers and hosts you connected to recently." />
      <RecentConnections variant="page" />
    </div>
  );
}

export default Connections;
