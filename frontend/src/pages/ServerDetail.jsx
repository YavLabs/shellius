import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Pencil, Trash2, Activity } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import HealthStatusDot from '@/components/shared/HealthStatusDot';
import ServerForm from '@/components/servers/ServerForm';
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
  const [server, setServer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [checking, setChecking] = useState(false);

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
        <div className="flex gap-2">
          <button
            onClick={handleHealthCheck}
            disabled={checking}
            className="flex h-9 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50"
          >
            <Activity className={`h-4 w-4 ${checking ? 'animate-pulse' : ''}`} />
            {checking ? 'Checking...' : 'Run Health Check'}
          </button>
          <button
            onClick={() => setEditOpen(true)}
            className="flex h-9 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground hover:bg-accent"
          >
            <Pencil className="h-4 w-4" /> Edit
          </button>
          <button
            onClick={() => setConfirmDelete(true)}
            className="flex h-9 items-center gap-1.5 rounded-md border border-destructive/50 bg-background px-3 text-sm font-medium text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-4 w-4" /> Delete
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Connection">
          <Field label="IP Address" value={server.ipAddress} mono />
          <Field label="Port" value={server.port} mono />
          <Field label="Protocol" value={server.protocol?.toUpperCase()} />
          <Field label="SSH User" value={server.sshUser} />
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
