import { useState, useEffect, useCallback } from 'react';
import { Plus, Wifi, ChevronLeft } from 'lucide-react';
import { SectionCard } from './shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import ProviderPicker from './sso/ProviderPicker';
import ProviderForm from './sso/ProviderForm';
import ProviderList from './sso/ProviderList';
import { getProvider } from '@/config/ssoProviders';
import { listSsoProviders } from '@/services/ssoConfigService';
import { listGroups as listOrgGroups } from '@/services/groupService';
import { useAuth } from '@/context/AuthContext';
import { roleAtLeast } from '@/lib/permissions';

function SsoTab() {
  const { user } = useAuth();
  const canManage = roleAtLeast(user, 'super_admin');

  const [providers, setProviders] = useState([]);
  const [orgGroups, setOrgGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // Add-provider dialog: null closed, 'pick' picker step, preset object = form step
  const [addStep, setAddStep] = useState(null);
  // Editing an existing provider — the provider DTO, or null
  const [editingProvider, setEditingProvider] = useState(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setLoadError('');
    return listSsoProviders()
      .then((list) => setProviders(list || []))
      .catch((err) =>
        setLoadError(err.response?.data?.error?.message || err.message || 'Failed to load SSO providers')
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    listOrgGroups()
      .then((res) => setOrgGroups(res?.items || res?.data?.items || res || []))
      .catch(() => setOrgGroups([]));
  }, [refresh]);

  const closeAddDialog = () => setAddStep(null);
  const closeEditDialog = () => setEditingProvider(null);

  const handleAdded = () => {
    closeAddDialog();
    refresh();
  };

  const handleEdited = () => {
    closeEditDialog();
    refresh();
  };

  return (
    <SectionCard
      title="Single Sign-On"
      description="Let people sign in with an identity provider instead of (or alongside) a password. Each active provider gets its own button on the login page."
    >
      <div className="mb-4 flex items-center justify-end">
        {canManage && (
          <Button type="button" onClick={() => setAddStep('pick')}>
            <Plus className="mr-2 h-4 w-4" />
            Add provider
          </Button>
        )}
      </div>

      {loading ? (
        <div className="space-y-3 py-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : loadError ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {loadError}
        </div>
      ) : providers.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-muted/20 px-6 py-10 text-center">
          <Wifi className="mx-auto h-10 w-10 text-muted-foreground/40" />
          <p className="mt-3 text-sm font-medium text-muted-foreground">No SSO providers configured</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {canManage
              ? 'Add a provider so people can sign in without a Shellius password.'
              : 'Ask a super admin to configure one.'}
          </p>
          {canManage && (
            <Button type="button" variant="outline" className="mt-4" onClick={() => setAddStep('pick')}>
              <Plus className="mr-2 h-4 w-4" />
              Add provider
            </Button>
          )}
        </div>
      ) : (
        <ProviderList providers={providers} onEdit={setEditingProvider} onChanged={refresh} />
      )}

      {/* Add provider dialog */}
      <Dialog open={!!addStep} onOpenChange={(open) => !open && closeAddDialog()}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          {addStep === 'pick' ? (
            <>
              <DialogHeader>
                <DialogTitle>Add a provider</DialogTitle>
                <DialogDescription>Choose an identity provider to configure.</DialogDescription>
              </DialogHeader>
              <div className="mt-2">
                <ProviderPicker onSelect={(preset) => setAddStep(preset)} />
              </div>
            </>
          ) : addStep ? (
            <>
              <DialogHeader>
                <button
                  type="button"
                  onClick={() => setAddStep('pick')}
                  className="mb-1 inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  Choose a different provider
                </button>
                <DialogTitle>{addStep.label}</DialogTitle>
                <DialogDescription>{addStep.description}</DialogDescription>
              </DialogHeader>
              <div className="mt-2">
                <ProviderForm
                  preset={addStep}
                  orgGroups={orgGroups}
                  onSaved={handleAdded}
                  onCancel={closeAddDialog}
                />
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Edit provider dialog */}
      <Dialog open={!!editingProvider} onOpenChange={(open) => !open && closeEditDialog()}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          {editingProvider && (
            <>
              <DialogHeader>
                <DialogTitle>Edit {editingProvider.name}</DialogTitle>
                <DialogDescription>
                  {getProvider(editingProvider.presetId)?.description || 'Update this provider\'s configuration.'}
                </DialogDescription>
              </DialogHeader>
              <div className="mt-2">
                <ProviderForm
                  preset={getProvider(editingProvider.presetId) || { id: editingProvider.presetId, label: editingProvider.name, fields: ['clientId', 'clientSecret'], protocol: editingProvider.provider }}
                  existingProvider={editingProvider}
                  orgGroups={orgGroups}
                  onSaved={handleEdited}
                  onCancel={closeEditDialog}
                />
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}

export default SsoTab;
