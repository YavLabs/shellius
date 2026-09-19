import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { KeyRound, Plus, Upload, Send, Lock, Building2 } from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import IdentitiesTab from '@/components/keystore/IdentitiesTab';
import SshKeysTab from '@/components/keystore/SshKeysTab';
import DeploymentsTab from '@/components/keystore/DeploymentsTab';
import { useAuth } from '@/context/AuthContext';
import { can } from '@/lib/permissions';

const TABS_BY_SCOPE = {
  org: [
    { key: 'identities', label: 'Identities' },
    { key: 'keys', label: 'SSH Keys' },
    { key: 'deployments', label: 'Export to Servers' },
  ],
  // Personal items are never bound to org servers, so there's no export/
  // deploy workflow for them (docs/personal-vault.md rule 2).
  personal: [
    { key: 'identities', label: 'Identities' },
    { key: 'keys', label: 'SSH Keys' },
  ],
};

function Keystore() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const canViewOrg = can(user, 'keystore.view');
  const canManageOrg = can(user, 'keystore.manage');
  const canDeploy = can(user, 'keystore.deploy');
  // Feature switch on the user's profile — undefined (older cached session,
  // or an org that hasn't set it) treated as on. The vault.use / vault.hosts
  // permissions are the real per-role gate; the org switch is separate.
  const vaultFeatureOn = user?.features?.personalVault !== false;
  const canUsePersonal = can(user, 'vault.use') && vaultFeatureOn;
  const canSwitchScope = canViewOrg && canUsePersonal;

  const defaultScope = canViewOrg ? 'org' : 'personal';
  const initialScopeParam = searchParams.get('scope');
  const initialScope =
    initialScopeParam === 'personal' && canUsePersonal
      ? 'personal'
      : initialScopeParam === 'org' && canViewOrg
        ? 'org'
        : defaultScope;
  const [scope, setScope] = useState(initialScope);

  const TABS = TABS_BY_SCOPE[scope];
  const initialTab = TABS.some((t) => t.key === searchParams.get('tab')) ? searchParams.get('tab') : 'identities';
  const [activeTab, setActiveTab] = useState(initialTab);

  // Effective per-scope permissions passed to the tabs/modals below.
  const canManage = scope === 'personal' ? true : canManageOrg;
  // "Move to organization" needs keystore.manage regardless of scope — an
  // owner without it can still fully manage their own personal items, just
  // not promote them into the shared Keystore.
  const canMoveToOrg = scope === 'personal' && canManageOrg;
  const isAdmin = canManage;

  const identitiesRef = useRef(null);
  const keysRef = useRef(null);
  const deploymentsRef = useRef(null);

  const handleScopeChange = (nextScope) => {
    if (nextScope === scope) return;
    setScope(nextScope);
    const nextTabs = TABS_BY_SCOPE[nextScope];
    const nextTab = nextTabs.some((t) => t.key === activeTab) ? activeTab : 'identities';
    setActiveTab(nextTab);
    const next = new URLSearchParams(searchParams);
    next.set('scope', nextScope);
    next.set('tab', nextTab);
    next.delete('action');
    next.delete('highlight');
    setSearchParams(next, { replace: true });
  };

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

  // Deep-link actions: /keystore?scope=personal&tab=identities&action=new,
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
    if (action === 'deploy' && tab === 'deployments' && canDeploy) controller.openDeploy?.();
    if (highlight) controller.highlight?.(highlight);

    const next = new URLSearchParams(searchParams);
    next.delete('action');
    next.delete('highlight');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, activeTab, isAdmin, canDeploy]);

  const headerActions = activeTab === 'deployments' ? (
    canDeploy ? (
      <Button onClick={() => deploymentsRef.current?.openDeploy?.()}>
        <Send className="mr-2 h-4 w-4" /> Export to servers
      </Button>
    ) : null
  ) : !isAdmin ? null : activeTab === 'identities' ? (
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
  ) : null;

  const subtitle =
    scope === 'personal'
      ? 'Your private identities and keys — visible only to you.'
      : "Stored identities and SSH keys for hosts that can't use CA certificates.";

  return (
    <div className="space-y-6 p-6">
      <PageHeader icon={scope === 'personal' ? Lock : KeyRound} title="Keystore" subtitle={subtitle} helpKey="keystore">
        {headerActions}
      </PageHeader>

      {canSwitchScope && (
        <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-muted/30 p-1">
          <button
            type="button"
            onClick={() => handleScopeChange('org')}
            className={[
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              scope === 'org' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            ].join(' ')}
          >
            <Building2 className="h-3.5 w-3.5" /> Organization
          </button>
          <button
            type="button"
            onClick={() => handleScopeChange('personal')}
            className={[
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              scope === 'personal' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            ].join(' ')}
          >
            <Lock className="h-3.5 w-3.5" /> Personal
          </button>
        </div>
      )}

      {scope === 'org' && !canManage && (
        <div className="rounded-md border border-blue-500/40 bg-blue-500/10 px-3 py-2 text-sm text-blue-700 dark:text-blue-300">
          You have read-only access to the Keystore. Contact an admin to create or modify identities and keys.
        </div>
      )}

      {/* Mobile: tabs stay on one line (scroll inside the bar if they must). */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-border md:overflow-visible">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => handleTabChange(tab.key)}
            className={[
              'relative shrink-0 whitespace-nowrap px-2.5 py-2.5 text-sm font-medium transition-colors md:px-4',
              activeTab === tab.key
                ? 'border-b-2 border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            ].join(' ')}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'identities' && (
        <IdentitiesTab ref={identitiesRef} canManage={canManage} scope={scope} canMoveToOrg={canMoveToOrg} />
      )}
      {activeTab === 'keys' && (
        <SshKeysTab ref={keysRef} canManage={canManage} scope={scope} canMoveToOrg={canMoveToOrg} />
      )}
      {activeTab === 'deployments' && scope === 'org' && <DeploymentsTab ref={deploymentsRef} canManage={canManage} />}
    </div>
  );
}

export default Keystore;
