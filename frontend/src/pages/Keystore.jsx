import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { KeyRound } from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import IdentitiesTab from '@/components/keystore/IdentitiesTab';
import SshKeysTab from '@/components/keystore/SshKeysTab';
import DeploymentsTab from '@/components/keystore/DeploymentsTab';
import { useAuth } from '@/context/AuthContext';
import { can } from '@/lib/permissions';

const TABS = [
  { key: 'identities', label: 'Identities' },
  { key: 'keys', label: 'SSH Keys' },
  { key: 'deployments', label: 'Deployments' },
];

function Keystore() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = TABS.some((t) => t.key === searchParams.get('tab')) ? searchParams.get('tab') : 'identities';
  const [activeTab, setActiveTab] = useState(initialTab);
  const canManage = can(user, 'manageKeystore');

  const handleTabChange = (key) => {
    setActiveTab(key);
    setSearchParams({ tab: key }, { replace: true });
  };

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={KeyRound}
        title="Keystore"
        subtitle="Stored identities and SSH keys for hosts that can't use CA certificates."
      />

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

      {activeTab === 'identities' && <IdentitiesTab canManage={canManage} />}
      {activeTab === 'keys' && <SshKeysTab canManage={canManage} />}
      {activeTab === 'deployments' && <DeploymentsTab canManage={canManage} />}
    </div>
  );
}

export default Keystore;
