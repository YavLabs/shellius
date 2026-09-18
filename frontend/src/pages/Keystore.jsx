import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { KeyRound, Plus, Upload, Send } from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import IdentitiesTab from '@/components/keystore/IdentitiesTab';
import SshKeysTab from '@/components/keystore/SshKeysTab';
import DeploymentsTab from '@/components/keystore/DeploymentsTab';
import { useAuth } from '@/context/AuthContext';
import { can, roleAtLeast } from '@/lib/permissions';

const TABS = [
  { key: 'identities', label: 'Identities' },
  { key: 'keys', label: 'SSH Keys' },
  { key: 'deployments', label: 'Export to Servers' },
];

function Keystore() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = TABS.some((t) => t.key === searchParams.get('tab')) ? searchParams.get('tab') : 'identities';
  const [activeTab, setActiveTab] = useState(initialTab);
  const canManage = can(user, 'manageKeystore');
  const isAdmin = roleAtLeast(user, 'admin');

  const identitiesRef = useRef(null);
  const keysRef = useRef(null);
  const deploymentsRef = useRef(null);

  const handleTabChange = (key) => {
    setActiveTab(key);
    const next = new URLSearchParams(searchParams);
    next.set('tab', key);
    next.delete('action');
    setSearchParams(next, { replace: true });
  };

  // Keep local tab state in sync if the URL's ?tab= changes externally
  // (e.g. a Quick Actions / command palette navigation to this page).
  useEffect(() => {
    const tab = searchParams.get('tab');
    if (tab && TABS.some((t) => t.key === tab) && tab !== activeTab) {
      setActiveTab(tab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Deep-link actions: /keystore?tab=identities&action=new,
  // ?tab=keys&action=generate|import, ?tab=deployments&action=deploy,
  // and ?highlight=<id> (scroll to / open the matching row's detail).
  useEffect(() => {
    const tab = searchParams.get('tab') || 'identities';
    const action = searchParams.get('action');
    const highlight = searchParams.get('highlight');
    if ((!action && !highlight) || tab !== activeTab) return;

    const refMap = { identities: identitiesRef, keys: keysRef, deployments: deploymentsRef };
    const controller = refMap[tab]?.current;
    if (!controller) return;

    if (action === 'new' && tab === 'identities' && isAdmin) controller.openNew?.();
    if (action === 'import' && tab === 'keys' && isAdmin) controller.openImport?.();
    if (action === 'generate' && tab === 'keys' && isAdmin) controller.openGenerate?.();
    if (action === 'deploy' && tab === 'deployments' && isAdmin) controller.openDeploy?.();
    if (highlight) controller.highlight?.(highlight);

    const next = new URLSearchParams(searchParams);
    next.delete('action');
    next.delete('highlight');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, activeTab, isAdmin]);

  const headerActions = !isAdmin ? null : activeTab === 'identities' ? (
    <Button onClick={() => identitiesRef.current?.openNew?.()}>
      <Plus className="mr-2 h-4 w-4" /> New identity
    </Button>
  ) : activeTab === 'keys' ? (
    <div className="flex items-center gap-2">
      <Button variant="outline" onClick={() => keysRef.current?.openImport?.()}>
        <Upload className="mr-2 h-4 w-4" /> Import key
      </Button>
      <Button onClick={() => keysRef.current?.openGenerate?.()}>
        <Plus className="mr-2 h-4 w-4" /> Generate key
      </Button>
    </div>
  ) : activeTab === 'deployments' ? (
    <Button onClick={() => deploymentsRef.current?.openDeploy?.()}>
      <Send className="mr-2 h-4 w-4" /> Export to servers
    </Button>
  ) : null;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={KeyRound}
        title="Keystore"
        subtitle="Stored identities and SSH keys for hosts that can't use CA certificates."
        helpKey="keystore"
      >
        {headerActions}
      </PageHeader>

      {!canManage && (
        <div className="rounded-md border border-blue-500/40 bg-blue-500/10 px-3 py-2 text-sm text-blue-700 dark:text-blue-300">
          You have read-only access to the Keystore. Contact an admin to create or modify identities and keys.
        </div>
      )}

      <div className="flex items-center gap-1 border-b border-border">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => handleTabChange(tab.key)}
            className={[
              'relative px-4 py-2.5 text-sm font-medium transition-colors',
              activeTab === tab.key
                ? 'border-b-2 border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            ].join(' ')}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'identities' && <IdentitiesTab ref={identitiesRef} canManage={canManage} />}
      {activeTab === 'keys' && <SshKeysTab ref={keysRef} canManage={canManage} />}
      {activeTab === 'deployments' && <DeploymentsTab ref={deploymentsRef} canManage={canManage} />}
    </div>
  );
}

export default Keystore;
