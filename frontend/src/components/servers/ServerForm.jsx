import { useState, useEffect } from 'react';
import { X, ChevronDown, ChevronRight } from 'lucide-react';
import { listCustomers } from '@/services/customerService';
import PrivateIPWarning from './PrivateIPWarning';

const ENVIRONMENTS = ['demo', 'dev', 'staging', 'prod'];
const PROTOCOLS = ['ssh', 'rdp', 'both'];
const OS_TYPES = ['', 'linux', 'windows', 'macos'];
const CLOUD_PROVIDERS = ['', 'aws', 'azure', 'gcp', 'other'];

const ipv4Re = /^(25[0-5]|2[0-4]\d|[01]?\d\d?)(\.(25[0-5]|2[0-4]\d|[01]?\d\d?)){3}$/;

function defaultPort(protocol) {
  if (protocol === 'rdp') return 3389;
  return 22;
}

function ServerForm({ server, customerId: initialCustomerId, onSubmit, onCancel }) {
  const isEdit = !!server;
  const [hostname, setHostname] = useState(server?.hostname || '');
  const [displayName, setDisplayName] = useState(server?.displayName || '');
  const [description, setDescription] = useState(server?.description || '');

  const [ipAddress, setIpAddress] = useState(server?.ipAddress || '');
  const [ipError, setIpError] = useState('');
  const [port, setPort] = useState(server?.port || 22);
  const [protocol, setProtocol] = useState(server?.protocol || 'ssh');
  const [sshUser, setSshUser] = useState(server?.sshUser || 'root');

  const [customerId, setCustomerId] = useState(
    server?.customerId || initialCustomerId || ''
  );
  const [environment, setEnvironment] = useState(server?.environment || 'dev');

  const [labels, setLabels] = useState(server?.labels || []);
  const [labelInput, setLabelInput] = useState('');

  const [osType, setOsType] = useState(server?.osType || '');
  const [osVersion, setOsVersion] = useState(server?.osVersion || '');

  const [cloudOpen, setCloudOpen] = useState(
    !!(server?.cloudProvider || server?.cloudInstanceId || server?.cloudRegion)
  );
  const [cloudProvider, setCloudProvider] = useState(server?.cloudProvider || '');
  const [cloudInstanceId, setCloudInstanceId] = useState(server?.cloudInstanceId || '');
  const [cloudRegion, setCloudRegion] = useState(server?.cloudRegion || '');

  const [customers, setCustomers] = useState([]);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const data = await listCustomers({ page: 1, pageSize: 200, isActive: true });
        setCustomers(data.items || []);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  const handleProtocolChange = (val) => {
    setProtocol(val);
    setPort(defaultPort(val));
  };

  const handleIpBlur = () => {
    if (ipAddress && !ipv4Re.test(ipAddress)) {
      setIpError('Invalid IPv4 address');
    } else {
      setIpError('');
    }
  };

  const addLabel = () => {
    const v = labelInput.trim();
    if (v && !labels.includes(v)) {
      setLabels([...labels, v]);
    }
    setLabelInput('');
  };

  const removeLabel = (l) => {
    setLabels(labels.filter((x) => x !== l));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!hostname.trim()) {
      setError('Hostname is required');
      return;
    }
    if (!ipAddress || !ipv4Re.test(ipAddress)) {
      setError('Valid IPv4 address is required');
      return;
    }
    if (!customerId) {
      setError('Customer is required');
      return;
    }
    const payload = {
      hostname: hostname.trim(),
      displayName: displayName.trim() || undefined,
      description: description.trim() || undefined,
      ipAddress,
      port: Number(port),
      protocol,
      sshUser: sshUser.trim() || undefined,
      customerId,
      environment,
      labels,
      osType: osType || undefined,
      osVersion: osVersion.trim() || undefined,
      cloudProvider: cloudProvider || undefined,
      cloudInstanceId: cloudInstanceId.trim() || undefined,
      cloudRegion: cloudRegion.trim() || undefined,
    };
    setSubmitting(true);
    try {
      await onSubmit(payload);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to save');
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls =
    'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';
  const labelCls = 'mb-1.5 block text-sm font-medium text-foreground';
  const sectionCls = 'text-xs font-semibold uppercase tracking-wider text-muted-foreground';

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="space-y-3">
        <h4 className={sectionCls}>Basic Info</h4>
        <div>
          <label className={labelCls}>Hostname</label>
          <input
            className={inputCls}
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            placeholder="web-01.example.com"
            required
          />
        </div>
        <div>
          <label className={labelCls}>Display Name</label>
          <input
            className={inputCls}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls}>Description</label>
          <textarea
            rows={2}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      </div>

      <div className="space-y-3">
        <h4 className={sectionCls}>Connection</h4>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className={labelCls}>IP Address</label>
            <input
              className={`${inputCls} font-mono`}
              value={ipAddress}
              onChange={(e) => setIpAddress(e.target.value)}
              onBlur={handleIpBlur}
              placeholder="10.0.0.1"
              required
            />
            {ipError && <p className="mt-1 text-xs text-destructive">{ipError}</p>}
            <PrivateIPWarning ipAddress={ipAddress} variant="note" />
          </div>
          <div>
            <label className={labelCls}>Port</label>
            <input
              type="number"
              className={inputCls}
              value={port}
              onChange={(e) => setPort(e.target.value)}
              min={1}
              max={65535}
            />
          </div>
          <div>
            <label className={labelCls}>SSH User</label>
            <input
              className={inputCls}
              value={sshUser}
              onChange={(e) => setSshUser(e.target.value)}
            />
          </div>
        </div>
        <div>
          <label className={labelCls}>Protocol</label>
          <div className="flex gap-4">
            {PROTOCOLS.map((p) => (
              <label key={p} className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="radio"
                  checked={protocol === p}
                  onChange={() => handleProtocolChange(p)}
                />
                <span className="uppercase">{p}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <h4 className={sectionCls}>Classification</h4>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Customer</label>
            <select
              className={inputCls}
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              required
              disabled={!!initialCustomerId && !isEdit}
            >
              <option value="">Select customer...</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Environment</label>
            <select
              className={inputCls}
              value={environment}
              onChange={(e) => setEnvironment(e.target.value)}
            >
              {ENVIRONMENTS.map((env) => (
                <option key={env} value={env}>
                  {env}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <h4 className={sectionCls}>Labels</h4>
        <div className="flex flex-wrap gap-2">
          {labels.map((l) => (
            <span
              key={l}
              className="inline-flex items-center gap-1 rounded-full bg-accent px-2.5 py-1 text-xs text-foreground"
            >
              {l}
              <button
                type="button"
                onClick={() => removeLabel(l)}
                className="text-muted-foreground hover:text-destructive"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
        <input
          className={inputCls}
          value={labelInput}
          onChange={(e) => setLabelInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addLabel();
            }
          }}
          placeholder="Type and press Enter to add"
        />
      </div>

      <div className="space-y-3">
        <h4 className={sectionCls}>Operating System (Optional)</h4>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>OS Type</label>
            <select className={inputCls} value={osType} onChange={(e) => setOsType(e.target.value)}>
              {OS_TYPES.map((o) => (
                <option key={o} value={o}>
                  {o || '-'}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>OS Version</label>
            <input
              className={inputCls}
              value={osVersion}
              onChange={(e) => setOsVersion(e.target.value)}
              placeholder="Ubuntu 22.04"
            />
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <button
          type="button"
          onClick={() => setCloudOpen((p) => !p)}
          className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          {cloudOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          Cloud Info (Optional)
        </button>
        {cloudOpen && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Provider</label>
              <select
                className={inputCls}
                value={cloudProvider}
                onChange={(e) => setCloudProvider(e.target.value)}
              >
                {CLOUD_PROVIDERS.map((c) => (
                  <option key={c} value={c}>
                    {c || '-'}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Region</label>
              <input
                className={inputCls}
                value={cloudRegion}
                onChange={(e) => setCloudRegion(e.target.value)}
                placeholder="us-east-1"
              />
            </div>
            <div className="col-span-2">
              <label className={labelCls}>Instance ID</label>
              <input
                className={inputCls}
                value={cloudInstanceId}
                onChange={(e) => setCloudInstanceId(e.target.value)}
                placeholder="i-0123456789abcdef0"
              />
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="h-9 rounded-md border border-input bg-background px-4 text-sm font-medium text-foreground hover:bg-accent"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {submitting ? 'Saving...' : isEdit ? 'Save changes' : 'Create server'}
        </button>
      </div>
    </form>
  );
}

export default ServerForm;
