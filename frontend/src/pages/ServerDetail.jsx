import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Pencil, Trash2, Activity, Download, Eraser, Terminal } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import HealthStatusDot from '@/components/shared/HealthStatusDot';
import ServerForm from '@/components/servers/ServerForm';
import BootstrapModal from '@/components/servers/BootstrapModal';
import ProvisionModal from '@/components/servers/ProvisionModal';
import UninstallHostModal from '@/components/servers/UninstallHostModal';
import QuickConnectButton from '@/components/servers/QuickConnectButton';
import PrivateIPWarning from '@/components/servers/PrivateIPWarning';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/context/AuthContext';
import { roleAtLeast } from '@/lib/permissions';
import {
  getServer,
  updateServer,
  deleteServer,
  triggerHealthCheck,
} from '@/services/serverService';
import { formatDateTime, relativeTime } from '@/utils/time';

function Card({ title, children }) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-5 py-3">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}

function Field({ label, value, mono }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={`text-sm text-foreground ${mono ? 'font-mono' : ''}`}
      >
        {value ?? '-'}
      </span>
    </div>
  );
}

function ServerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user: currentUser } = useAuth();
  const [server, setServer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [checking, setChecking] = useState(false);
  const [bootstrapOpen, setBootstrapOpen] = useState(false);
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const [provisionOpen, setProvisionOpen] = useState(false);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await getServer(id);
      setServer(data);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load server');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  const handleEdit = async (payload) => {
    await updateServer(id, payload);
    setEditOpen(false);
    fetch();
  };

  const handleDelete = async () => {
    await deleteServer(id);
    navigate('/servers');
  };

  const handleHealthCheck = async () => {
    setChecking(true);
    try {
      const updated = await triggerHealthCheck(id);
      setServer(updated);
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Health check failed');
    } finally {
      setChecking(false);
    }
  };

  const canManage = roleAtLeast(currentUser, 'manager'); // onboard/edit servers
  const canDelete = roleAtLeast(currentUser, 'admin');
  const canProvision =
    server &&
    (server.protocol === 'ssh' || server.protocol === 'both') &&
    server.osType !== 'windows' &&
    canManage;

  if (loading) {
    return (
      <div className="p-6">
        <div className="h-8 w-64 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  if (error || !server) {
    return (
      <div className="p-6">
        <button
          onClick={() => navigate('/servers')}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Back to servers
        </button>
        <div className="mt-4 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error || 'Server not found'}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 p-6">
      <button
        onClick={() => navigate('/servers')}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Back to servers
      </button>

      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              {server.hostname}
            </h1>
            <HealthStatusDot status={server.healthStatus} showLabel />
            <EnvironmentBadge environment={server.environment} />
          </div>
          {server.displayName && (
            <p className="mt-1 text-sm text-muted-foreground">{server.displayName}</p>
          )}
          {server.description && (
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{server.description}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* QuickConnectButton renders Connect (when an active AR exists)
              or Request Access (when one doesn't) — same source of truth as
              the Servers list row, so the two views can never disagree. */}
          <QuickConnectButton server={server} currentUser={currentUser} />
          {canManage && (
            <>
              <Button variant="outline" size="sm" onClick={() => setBootstrapOpen(true)}>
                <Download className="mr-2 h-4 w-4" /> Bootstrap Host
              </Button>
              {canProvision && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setProvisionOpen(true)}
                  className="gap-1.5"
                >
                  <Terminal className="h-4 w-4" />
                  Auto-Provision
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => setUninstallOpen(true)}>
                <Eraser className="mr-2 h-4 w-4" /> Uninstall Agent
              </Button>
              <Button variant="outline" size="sm" onClick={handleHealthCheck} disabled={checking}>
                <Activity className={`mr-2 h-4 w-4 ${checking ? 'animate-pulse' : ''}`} />
                {checking ? 'Checking...' : 'Run Health Check'}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                <Pencil className="mr-2 h-4 w-4" /> Edit
              </Button>
            </>
          )}
          {canDelete && (
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="mr-2 h-4 w-4" /> Delete
            </Button>
          )}
        </div>
      </div>

      <PrivateIPWarning ipAddress={server.ipAddress} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Connection">
          <Field label="IP Address" value={server.ipAddress} mono />
          <Field label="Port" value={server.port} mono />
          <Field label="Protocol" value={server.protocol?.toUpperCase()} />
          {(server.protocol === 'ssh' || server.protocol === 'both') && (
            <Field label="SSH User" value={server.sshUser} />
          )}
          {(server.protocol === 'rdp' || server.protocol === 'both') && (
            <Field label="RDP User" value={server.rdpUsername || '-'} />
          )}
          {(server.protocol === 'rdp' || server.protocol === 'both') && (
            <Field label="RDP Password" value={server.hasRdpPassword ? '••••••••' : 'Not set'} />
          )}
        </Card>

        <Card title="System">
          <Field label="OS Type" value={server.osType} />
          <Field label="OS Version" value={server.osVersion} />
          <Field
            label="Customer"
            value={server.customer?.name || '-'}
          />
        </Card>

        <Card title="Health">
          <Field label="Status" value={server.healthStatus} />
          <Field label="Last Check" value={formatDateTime(server.lastHealthCheckAt)} />
          <Field label="Relative" value={relativeTime(server.lastHealthCheckAt)} />
          <Field label="Message" value={server.healthMessage} />
        </Card>

        <Card title="Onboarding">
          <Field label="Status" value={server.provisionStatus || 'pending'} />
          {server.provisionStatus === 'failed' && (
            <Field label="Error" value={server.provisionError} />
          )}
          <Field label="Provisioned" value={formatDateTime(server.provisionedAt)} />
          {server.provisionStatus !== 'provisioned' && canProvision && (
            <div className="pt-2">
              <Button size="sm" onClick={() => setProvisionOpen(true)}>
                {server.provisionStatus === 'failed' ? 'Retry onboarding' : 'Onboard now'}
              </Button>
              <p className="mt-1 text-xs text-muted-foreground">
                Runs the agent install over SSH using credentials you provide.
              </p>
            </div>
          )}
        </Card>

        {(server.cloudProvider || server.cloudInstanceId || server.cloudRegion) && (
          <Card title="Cloud">
            <Field label="Provider" value={server.cloudProvider} />
            <Field label="Instance ID" value={server.cloudInstanceId} mono />
            <Field label="Region" value={server.cloudRegion} />
            <Field label="Account" value={server.cloudAccount} />
          </Card>
        )}

        {(server.agentId || server.agentVersion) && (
          <Card title="Agent">
            <Field label="Agent ID" value={server.agentId} mono />
            <Field label="Version" value={server.agentVersion} />
            <Field label="Last Seen" value={formatDateTime(server.agentLastSeenAt)} />
          </Card>
        )}

        <Card title="Labels">
          {server.labels && server.labels.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {server.labels.map((l) => (
                <span
                  key={l}
                  className="inline-flex items-center rounded-full bg-accent px-2.5 py-1 text-xs text-foreground"
                >
                  {l}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No labels</p>
          )}
        </Card>
      </div>

      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="Edit Server"
        size="lg"
      >
        <ServerForm
          server={server}
          onSubmit={handleEdit}
          onCancel={() => setEditOpen(false)}
        />
      </Modal>

      <BootstrapModal
        open={bootstrapOpen}
        server={server}
        onClose={() => setBootstrapOpen(false)}
      />

      {provisionOpen && (
        <ProvisionModal
          server={server}
          onClose={() => {
            setProvisionOpen(false);
            fetch();
          }}
        />
      )}

      <UninstallHostModal
        open={uninstallOpen}
        server={server}
        onClose={() => setUninstallOpen(false)}
      />

      <ConfirmDialog
        open={confirmDelete}
        title="Delete server"
        message={`Permanently delete ${server.hostname}? This cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}

export default ServerDetail;
