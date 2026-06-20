import { useState, useEffect } from 'react';
import { X, ChevronDown, ChevronRight, Info } from 'lucide-react';
import { listCustomers } from '@/services/customerService';
import PrivateIPWarning from './PrivateIPWarning';

const ENVIRONMENTS = ['demo', 'dev', 'staging', 'prod'];
const OS_TYPES = ['', 'linux', 'windows', 'macos', 'other'];
const CLOUD_PROVIDERS = ['', 'aws', 'azure', 'gcp', 'other'];

// Protocols available per OS. Unlisted / empty OS gets all three.
const PROTOCOLS_BY_OS = {
  linux: ['ssh'],
  macos: ['ssh'],
  windows: ['rdp', 'ssh', 'both'],
  other:  ['ssh', 'rdp', 'both'],
  '':     ['ssh', 'rdp', 'both'],
};

const PROTOCOL_LABELS = { ssh: 'SSH', rdp: 'RDP', both: 'Both' };

// Human-readable note shown when the OS constrains protocol options.
const OS_PROTOCOL_NOTES = {
  linux: 'Linux servers use SSH. RDP requires xrdp which is unsupported.',
  macos: 'macOS servers use SSH only.',
  windows: 'Windows supports RDP natively. Select SSH if OpenSSH for Windows is installed, or Both to enable both.',
};

const ipv4Re = /^(25[0-5]|2[0-4]\d|[01]?\d\d?)(\.(25[0-5]|2[0-4]\d|[01]?\d\d?)){3}$/;

function getAllowedProtocols(os) {
  return PROTOCOLS_BY_OS[os] ?? ['ssh', 'rdp', 'both'];
}

function getDefaultProtocol(os) {
  return os === 'windows' ? 'rdp' : 'ssh';
}

function defaultPort(protocol) {
  if (protocol === 'rdp') return 3389;
  return 22;
}

function includesSsh(protocol) {
  return protocol === 'ssh' || protocol === 'both';
}

function includesRdp(protocol) {
  return protocol === 'rdp' || protocol === 'both';
}

function ServerForm({ server, customerId: initialCustomerId, onSubmit, onCancel }) {
  const isEdit = !!server;

  // ── Basic Info ──────────────────────────────────────────────────────────
  const [hostname, setHostname]       = useState(server?.hostname || '');
  const [displayName, setDisplayName] = useState(server?.displayName || '');
  const [description, setDescription] = useState(server?.description || '');

  // ── OS (drives protocol list — must be resolved before protocol state) ──
  const [osType, setOsType]       = useState(server?.osType || '');
  const [osVersion, setOsVersion] = useState(server?.osVersion || '');

  // Derive initial protocol: honour existing value only if it is valid for the OS.
  const initialProtocol = (() => {
    const existing = server?.protocol || 'ssh';
    const allowed  = getAllowedProtocols(server?.osType || '');
    return allowed.includes(existing) ? existing : getDefaultProtocol(server?.osType || '');
  })();

  // ── Connection ───────────────────────────────────────────────────────────
  const [ipAddress, setIpAddress] = useState(server?.ipAddress || '');
  const [ipError, setIpError]     = useState('');
  const [protocol, setProtocol]   = useState(initialProtocol);
  const [port, setPort]           = useState(server?.port || defaultPort(initialProtocol));
  const [sshUser, setSshUser]     = useState(server?.sshUser || 'root');

  // ── RDP credentials ──────────────────────────────────────────────────────
  const [rdpUsername, setRdpUsername] = useState(server?.rdpUsername || '');
  const [rdpPassword, setRdpPassword] = useState('');

  // ── Classification ───────────────────────────────────────────────────────
  const [customerId, setCustomerId] = useState(server?.customerId || initialCustomerId || '');
  const [environment, setEnvironment] = useState(server?.environment || 'dev');

  // ── Labels ───────────────────────────────────────────────────────────────
  const [labels, setLabels]         = useState(server?.labels || []);
  const [labelInput, setLabelInput] = useState('');

  // ── Cloud info (collapsible) ─────────────────────────────────────────────
  const [cloudOpen, setCloudOpen]           = useState(!!(server?.cloudProvider || server?.cloudInstanceId || server?.cloudRegion));
  const [cloudProvider, setCloudProvider]   = useState(server?.cloudProvider || '');
  const [cloudInstanceId, setCloudInstanceId] = useState(server?.cloudInstanceId || '');
  const [cloudRegion, setCloudRegion]       = useState(server?.cloudRegion || '');

  // ── UI state ─────────────────────────────────────────────────────────────
  const [customers, setCustomers] = useState([]);
  const [error, setError]         = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const data = await listCustomers({ page: 1, pageSize: 200, isActive: true });
        setCustomers(data.items || []);
      } catch { /* ignore */ }
    })();
  }, []);

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleOsTypeChange = (val) => {
    setOsType(val);
    const allowed = getAllowedProtocols(val);
    if (!allowed.includes(protocol)) {
      const next = getDefaultProtocol(val);
      setProtocol(next);
      setPort(defaultPort(next));
    }
  };

  const handleProtocolChange = (val) => {
    setProtocol(val);
    // Only auto-update port if the user hasn't manually overridden it to something
    // other than the standard ports — preserves custom port entries.
    if (port === 22 || port === 3389) {
      setPort(defaultPort(val));
    }
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
    if (v && !labels.includes(v)) setLabels([...labels, v]);
    setLabelInput('');
  };

  const removeLabel = (l) => setLabels(labels.filter((x) => x !== l));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!hostname.trim())                         { setError('Hostname is required'); return; }
    if (!ipAddress || !ipv4Re.test(ipAddress))    { setError('Valid IPv4 address is required'); return; }
    if (!customerId)                              { setError('Customer is required'); return; }

    const payload = {
      hostname:        hostname.trim(),
      displayName:     displayName.trim() || undefined,
      description:     description.trim() || undefined,
      ipAddress,
      port:            Number(port),
      protocol,
      customerId,
      environment,
      labels,
      osType:          osType || undefined,
      osVersion:       osVersion.trim() || undefined,
      cloudProvider:   cloudProvider || undefined,
      cloudInstanceId: cloudInstanceId.trim() || undefined,
      cloudRegion:     cloudRegion.trim() || undefined,
    };

    // SSH user is only meaningful for SSH-capable servers
    if (includesSsh(protocol)) {
      payload.sshUser = sshUser.trim() || 'root';
    }

    // RDP credentials only for RDP-capable servers
    if (includesRdp(protocol)) {
      if (rdpUsername) payload.rdpUsername = rdpUsername.trim();
      if (rdpPassword) payload.rdpPassword = rdpPassword;
    }

    setSubmitting(true);
    try {
      await onSubmit(payload);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to save');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Style helpers ─────────────────────────────────────────────────────────
  const inputCls   = 'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';
  const labelCls   = 'mb-1.5 block text-sm font-medium text-foreground';
  const sectionCls = 'text-xs font-semibold uppercase tracking-wider text-muted-foreground';

  const allowedProtocols = getAllowedProtocols(osType);
  const protocolConstrained = osType && allowedProtocols.length < 3;

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* ── 1. Basic Info ─────────────────────────────────────────────── */}
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
          <label className={labelCls}>Name</label>
          <input
            className={inputCls}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Friendly name (e.g. Acme Prod Web)"
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

      {/* ── 2. OS Type — comes first so protocol options are driven by it ── */}
      <div className="space-y-3">
        <h4 className={sectionCls}>Operating System</h4>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>OS Type</label>
            <select
              className={inputCls}
              value={osType}
              onChange={(e) => handleOsTypeChange(e.target.value)}
            >
              {OS_TYPES.map((o) => (
                <option key={o} value={o}>{o || 'Unknown / Not specified'}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>OS Version <span className="font-normal text-muted-foreground">(optional)</span></label>
            <input
              className={inputCls}
              value={osVersion}
              onChange={(e) => setOsVersion(e.target.value)}
              placeholder="Ubuntu 22.04"
            />
          </div>
        </div>
      </div>

      {/* ── 3. Connection ─────────────────────────────────────────────── */}
      <div className="space-y-3">
        <h4 className={sectionCls}>Connection</h4>

        {/* IP Address */}
        <div>
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

        {/* Protocol — filtered by OS type */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label className={labelCls} style={{ marginBottom: 0 }}>Protocol</label>
            {protocolConstrained && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Info className="h-3 w-3" />
                Determined by OS type
              </span>
            )}
          </div>

          <div className="flex gap-4">
            {allowedProtocols.map((p) => (
              <label key={p} className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                <input
                  type="radio"
                  checked={protocol === p}
                  onChange={() => handleProtocolChange(p)}
                />
                <span>{PROTOCOL_LABELS[p]}</span>
              </label>
            ))}
          </div>

          {/* Contextual note about why options are limited */}
          {protocolConstrained && OS_PROTOCOL_NOTES[osType] && (
            <p className="mt-1.5 text-xs text-muted-foreground">{OS_PROTOCOL_NOTES[osType]}</p>
          )}
        </div>

        {/* Port + SSH User — SSH User only shown when SSH is included */}
        <div className="grid grid-cols-2 gap-3">
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
          {includesSsh(protocol) && (
            <div>
              <label className={labelCls}>SSH User</label>
              <input
                className={inputCls}
                value={sshUser}
                onChange={(e) => setSshUser(e.target.value)}
                placeholder="root"
              />
            </div>
          )}
        </div>
      </div>

      {/* ── 4. RDP Credentials — only when RDP is involved ────────────── */}
      {includesRdp(protocol) && (
        <div className="space-y-3">
          <h4 className={sectionCls}>RDP Credentials</h4>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>RDP Username</label>
              <input
                className={inputCls}
                value={rdpUsername}
                onChange={(e) => setRdpUsername(e.target.value)}
                placeholder="Administrator"
                autoComplete="off"
              />
            </div>
            <div>
              <label className={labelCls}>
                RDP Password{' '}
                {isEdit && (
                  <span className="font-normal text-muted-foreground">(blank = keep current)</span>
                )}
              </label>
              <input
                type="password"
                className={inputCls}
                value={rdpPassword}
                onChange={(e) => setRdpPassword(e.target.value)}
                placeholder={isEdit ? '••••••••' : 'Enter password'}
                autoComplete="new-password"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Credentials are encrypted at rest and injected via the Guacamole gateway — never exposed to browsers.
          </p>
        </div>
      )}

      {/* ── 5. Classification ─────────────────────────────────────────── */}
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
                <option key={c.id} value={c.id}>{c.name}</option>
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
                <option key={env} value={env}>{env}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* ── 6. Labels ────────────────────────────────────────────────── */}
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
            if (e.key === 'Enter') { e.preventDefault(); addLabel(); }
          }}
          placeholder="Type and press Enter to add"
        />
      </div>

      {/* ── 7. Cloud Info (collapsible) ───────────────────────────────── */}
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
                  <option key={c} value={c}>{c || '-'}</option>
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

      {/* ── Actions ──────────────────────────────────────────────────── */}
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
