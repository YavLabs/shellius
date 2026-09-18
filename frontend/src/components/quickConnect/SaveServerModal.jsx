import { useEffect, useState } from 'react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import SaveServerFields from './SaveServerFields';
import { listCredentials } from '@/services/keystoreService';
import { saveQuickConnectServer } from '@/services/quickConnectService';

/**
 * SaveServerModal — "Save as server" after an already-open Quick Connect
 * terminal session. No secrets are available at this point (tickets are
 * single-use and never retained) — the only identity options are an
 * existing saved identity, or none (certificate mode, bootstrap later).
 */
function SaveServerModal({ open, onClose, connection, onSaved }) {
  const [values, setValues] = useState({ identityMode: 'existing', environment: 'dev' });
  const [identities, setIdentities] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setValues({
      identityMode: 'existing',
      environment: 'dev',
      hostname: connection?.host || '',
      displayName: '',
    });
    setError('');
    listCredentials()
      .then(setIdentities)
      .catch(() => setIdentities([]));
  }, [open, connection]);

  const handleSave = async () => {
    setError('');
    setSaving(true);
    try {
      const payload = {
        host: connection?.host,
        port: connection?.port,
        username: connection?.username,
        hostname: values.hostname?.trim() || connection?.host,
        displayName: values.displayName?.trim() || undefined,
        customerId: values.customerId,
        environment: values.environment || 'dev',
        description: values.description?.trim() || undefined,
        hostKeyFingerprint: connection?.hostKeyFingerprint,
        hostKeyAlgorithm: connection?.hostKeyAlgorithm,
        identity:
          values.identityMode === 'existing'
            ? { mode: 'existing', credentialId: values.identityId }
            : { mode: 'none' },
      };
      const server = await saveQuickConnectServer(payload);
      onSaved?.(server);
      onClose();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to save server');
    } finally {
      setSaving(false);
    }
  };

  const canSave =
    !!values.hostname?.trim() &&
    !!values.customerId &&
    (values.identityMode !== 'existing' || !!values.identityId);

  return (
    <Modal open={open} onClose={onClose} title="Save as server" size="md">
      <div className="space-y-4">
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        <SaveServerFields
          values={values}
          onChange={setValues}
          identities={identities}
          canCreateIdentity={false}
          identityModes={['existing', 'none']}
        />
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={!canSave || saving} onClick={handleSave}>
            {saving ? 'Saving...' : 'Save server'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default SaveServerModal;
