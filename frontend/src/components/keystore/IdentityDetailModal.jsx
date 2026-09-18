import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Server as ServerIcon } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import AuthTypeBadge from './AuthTypeBadge';
import { getCredential } from '@/services/keystoreService';

function IdentityDetailModal({ open, onClose, credentialId }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !credentialId) return;
    setLoading(true);
    setError('');
    getCredential(credentialId)
      .then(setData)
      .catch((err) => setError(err.response?.data?.error?.message || 'Failed to load identity'))
      .finally(() => setLoading(false));
  }, [open, credentialId]);

  const credential = data?.credential;
  const servers = data?.servers || [];

  return (
    <Modal open={open} onClose={onClose} title={credential?.name || 'Identity'} size="md">
      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : error ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Username</p>
              <p className="font-mono text-foreground">{credential?.username}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Auth type</p>
              <AuthTypeBadge authType={credential?.authType} />
            </div>
            {credential?.sshKey && (
              <div className="col-span-2">
                <p className="text-xs text-muted-foreground">Linked key</p>
                <p className="text-foreground">
                  {credential.sshKey.name}{' '}
                  <span className="font-mono text-xs text-muted-foreground">{credential.sshKey.fingerprint}</span>
                </p>
              </div>
            )}
            {credential?.description && (
              <div className="col-span-2">
                <p className="text-xs text-muted-foreground">Description</p>
                <p className="text-foreground">{credential.description}</p>
              </div>
            )}
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Servers using this identity ({servers.length})
            </p>
            {servers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No servers currently use this identity.</p>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {servers.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        navigate(`/servers/${s.id}`);
                      }}
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <ServerIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{s.displayName || s.hostname}</span>
                      </span>
                      {s.environment && <EnvironmentBadge environment={s.environment} />}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

export default IdentityDetailModal;
