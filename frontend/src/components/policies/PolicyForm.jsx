import { useState, useEffect, useCallback } from 'react';
import { X, Plus, FlaskConical, Info, CheckCircle2, XCircle, Zap, Siren, Key, Check } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import { listCustomers } from '@/services/customerService';
import { listServers } from '@/services/serverService';
import { listGroups } from '@/services/groupService';
import PolicyEvaluator from '@/components/policies/PolicyEvaluator';
import SubjectsPicker from '@/components/policies/SubjectsPicker';

const ENVIRONMENTS = ['demo', 'dev', 'staging', 'prod'];

/**
 * SectionHeader — a clean numbered heading with a one-line description.
 * Used in the new single-scroll PolicyForm layout (replaces the old
 * step-by-step wizard).
 */
function SectionHeader({ number, title, description }) {
  return (
    <div className="flex items-start gap-3 mb-4">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
        {number}
      </div>
      <div>
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {description && (
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        )}
      </div>
    </div>
  );
}

/**
 * PolicySummary — a live plain-English sentence that describes what the
 * current form values will do. Updates as the user types.
 */
function PolicySummary({ form }) {
  const effect = form.effect === 'DENY' ? 'Denies' : 'Allows';
  const EffectIcon = form.effect === 'DENY' ? XCircle : CheckCircle2;
  const effectClass =
    form.effect === 'DENY'
      ? 'border-destructive/30 bg-destructive/5 text-destructive'
      : 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400';

  // Subjects
  const userCount = form.subjects?.filter((s) => s.subjectType === 'USER').length || 0;
  const groupCount = form.subjects?.filter((s) => s.subjectType === 'GROUP').length || 0;
  const roleCount = form.subjects?.filter((s) => s.subjectType === 'ROLE').length || 0;
  const subjectParts = [];
  if (userCount) subjectParts.push(`${userCount} user${userCount !== 1 ? 's' : ''}`);
  if (groupCount) subjectParts.push(`${groupCount} group${groupCount !== 1 ? 's' : ''}`);
  if (roleCount) {
    const roleNames = form.subjects.filter((s) => s.subjectType === 'ROLE').map((s) => s.subjectId);
    subjectParts.push(roleNames.length === 1 ? `all ${roleNames[0]}s` : `${roleCount} roles`);
  }
  const who = subjectParts.length ? subjectParts.join(' + ') : 'nobody (yet)';

  // Targets
  const envCount = form.targetEnvironments?.length || 0;
  const serverCount = form.targetServerIds?.length || 0;
  const labelCount = Object.keys(form.targetLabels || {}).length;
  let where;
  if (serverCount) where = `${serverCount} specific server${serverCount !== 1 ? 's' : ''}`;
  else if (envCount) where = `all ${form.targetEnvironments.join('/')} servers`;
  else if (labelCount) where = `servers matching ${labelCount} label${labelCount !== 1 ? 's' : ''}`;
  else where = 'every server in the org';

  // Constraints
  const mins = Math.round((form.maxSessionDuration || 0) / 60);
  const duration =
    mins >= 60
      ? `${Math.round((mins / 60) * 10) / 10}h`
      : `${mins}m`;
  const approvalTag = form.autoApprove
    ? 'auto-approved'
    : form.requireApproval
    ? 'after manager approval'
    : 'subject to policy evaluation';

  // JIT
  const hasJit =
    form.osProvisioning &&
    ((form.osProvisioning.linuxGroups || []).length > 0 ||
      form.osProvisioning.sudo ||
      (form.osProvisioning.aclReadPaths || []).length > 0 ||
      form.osProvisioning.hardCutoff);

  const principals = form.allowedPrincipals?.length
    ? form.allowedPrincipals.join(', ')
    : 'any principal';

  return (
    <div className={`rounded-md border px-4 py-3 ${effectClass}`}>
      <div className="flex items-start gap-2">
        <EffectIcon className="h-4 w-4 mt-0.5 shrink-0" />
        <div className="text-xs leading-relaxed">
          <strong className="text-sm">{effect}</strong> {who} to connect as{' '}
          <span className="font-mono">{principals}</span> on {where} for up to{' '}
          <strong>{duration}</strong> per session, {approvalTag}.
          {hasJit && (
            <span className="flex items-start gap-1.5 mt-1 text-[11px] opacity-80">
              <Zap className="h-3 w-3 mt-0.5 shrink-0" />
              <span>
                JIT provisioning enabled — target hosts will auto-create a per-user Linux
                account for each session.
              </span>
            </span>
          )}
          {form.isBreakGlass && (
            <span className="flex items-start gap-1.5 mt-1 text-[11px] opacity-80">
              <Siren className="h-3 w-3 mt-0.5 shrink-0" />
              <span>Marked as a break-glass policy — invoking it notifies all admins.</span>
            </span>
          )}
          {form.allowKeyDownload && (
            <span className="flex items-start gap-1.5 mt-1 text-[11px] opacity-80">
              <Key className="h-3 w-3 mt-0.5 shrink-0" />
              <span>SSH key download enabled — users can take credentials offline.</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

const inputCls =
  'w-full h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';
const labelCls = 'block text-sm font-medium text-foreground mb-1';
const errorCls = 'text-xs text-destructive mt-1';

// StepIndicator removed — the form is now single-scroll; see SectionHeader.

function Chip({ label, onRemove }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-accent px-2.5 py-0.5 text-xs font-medium text-foreground">
      {label}
      <button
        type="button"
        onClick={onRemove}
        className="ml-0.5 text-muted-foreground hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

// Step 1 ─────────────────────────────────────────────────────────────────────
function Step1({ form, onChange, errors }) {
  return (
    <div className="space-y-4">
      <div>
        <label className={labelCls}>Policy Name *</label>
        <input
          className={inputCls}
          value={form.name}
          onChange={(e) => onChange('name', e.target.value)}
          placeholder="e.g. Dev servers - engineering team"
        />
        {errors.name && <p className={errorCls}>{errors.name}</p>}
      </div>
      <div>
        <label className={labelCls}>Description</label>
        <textarea
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none"
          rows={2}
          value={form.description}
          onChange={(e) => onChange('description', e.target.value)}
          placeholder="Optional description..."
        />
      </div>
      <div>
        <label className={labelCls}>Effect *</label>
        <div className="flex gap-4 mt-1">
          {['ALLOW', 'DENY'].map((eff) => (
            <label key={eff} className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="effect"
                value={eff}
                checked={form.effect === eff}
                onChange={() => onChange('effect', eff)}
                className="accent-primary"
              />
              <span
                className={[
                  'text-sm font-medium',
                  eff === 'ALLOW' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400',
                ].join(' ')}
              >
                {eff}
              </span>
            </label>
          ))}
        </div>
        {errors.effect && <p className={errorCls}>{errors.effect}</p>}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelCls}>Priority</label>
          <input
            className={inputCls}
            type="number"
            min={1}
            max={1000}
            value={form.priority}
            onChange={(e) => onChange('priority', Number(e.target.value))}
          />
          <p className="text-xs text-muted-foreground mt-1">Higher priority evaluates first (1–1000).</p>
        </div>
        <div className="flex flex-col justify-end pb-1">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => onChange('isActive', e.target.checked)}
              className="accent-primary h-4 w-4"
            />
            <span className="text-sm font-medium text-foreground">Active</span>
          </label>
          <p className="text-xs text-muted-foreground mt-1">Inactive policies are not evaluated.</p>
        </div>
      </div>
    </div>
  );
}

// Step 2 ─────────────────────────────────────────────────────────────────────
function Step2({ form, onChange, errors }) {
  return (
    <div className="space-y-3">
      <SubjectsPicker
        subjects={form.subjects || []}
        onChange={(next) => onChange('subjects', next)}
      />
      {errors.subjects && <p className={errorCls}>{errors.subjects}</p>}
    </div>
  );
}


// Step 3 ─────────────────────────────────────────────────────────────────────
function Step3({ form, onChange, errors }) {
  const [customers, setCustomers] = useState([]);
  const [servers, setServers] = useState([]);
  const [serverSearch, setServerSearch] = useState('');
  const [principalInput, setPrincipalInput] = useState('');
  const [labelKey, setLabelKey] = useState('');
  const [labelVal, setLabelVal] = useState('');

  useEffect(() => {
    listCustomers({ page: 1, pageSize: 200 })
      .then((d) => setCustomers(d.items || []))
      .catch(() => setCustomers([]));
  }, []);

  const fetchServers = useCallback(async () => {
    const params = { page: 1, pageSize: 200 };
    if (form.customerId) params.customerId = form.customerId;
    try {
      const d = await listServers(params);
      setServers(d.items || []);
    } catch {
      setServers([]);
    }
  }, [form.customerId]);

  useEffect(() => {
    fetchServers();
  }, [fetchServers]);

  const toggleEnv = (env) => {
    const envs = form.targetEnvironments || [];
    onChange(
      'targetEnvironments',
      envs.includes(env) ? envs.filter((e) => e !== env) : [...envs, env]
    );
  };

  const filteredServers = servers.filter((s) => {
    const q = serverSearch.toLowerCase();
    return !q || (s.hostname || '').toLowerCase().includes(q);
  });

  const toggleServer = (id) => {
    const ids = form.targetServerIds || [];
    onChange(
      'targetServerIds',
      ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]
    );
  };

  const addPrincipal = () => {
    const val = principalInput.trim();
    if (!val) return;
    const list = form.allowedPrincipals || [];
    if (!list.includes(val)) onChange('allowedPrincipals', [...list, val]);
    setPrincipalInput('');
  };

  const removePrincipal = (p) => {
    onChange('allowedPrincipals', (form.allowedPrincipals || []).filter((x) => x !== p));
  };

  const addLabel = () => {
    const k = labelKey.trim();
    const v = labelVal.trim();
    if (!k) return;
    const current = form.targetLabels || {};
    onChange('targetLabels', { ...current, [k]: v });
    setLabelKey('');
    setLabelVal('');
  };

  const removeLabel = (k) => {
    const next = { ...(form.targetLabels || {}) };
    delete next[k];
    onChange('targetLabels', next);
  };

  return (
    <div className="space-y-5">
      <div>
        <label className={labelCls}>Customer Scope</label>
        <select
          className={inputCls}
          value={form.customerId || ''}
          onChange={(e) => {
            onChange('customerId', e.target.value || null);
            onChange('targetServerIds', []);
          }}
        >
          <option value="">Org-wide (all customers)</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className={labelCls}>Target Environments</label>
        <div className="flex flex-wrap gap-2 mt-1">
          {ENVIRONMENTS.map((env) => {
            const active = (form.targetEnvironments || []).includes(env);
            return (
              <button
                key={env}
                type="button"
                onClick={() => toggleEnv(env)}
                className={[
                  'inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wider border transition-colors',
                  active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-background text-muted-foreground hover:border-muted-foreground',
                ].join(' ')}
              >
                {env}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground mt-1">Leave empty to match all environments.</p>
      </div>

      <div>
        <label className={labelCls}>Target Servers</label>
        <input
          className={inputCls}
          placeholder="Search servers..."
          value={serverSearch}
          onChange={(e) => setServerSearch(e.target.value)}
        />
        <div className="mt-1 max-h-36 overflow-y-auto rounded-md border border-border">
          {filteredServers.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">No servers found</p>
          ) : (
            filteredServers.map((s) => {
              const selected = (form.targetServerIds || []).includes(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => toggleServer(s.id)}
                  className={[
                    'flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-accent',
                    selected ? 'bg-accent/60' : '',
                  ].join(' ')}
                >
                  <div
                    className={[
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                      selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
                    ].join(' ')}
                  >
                    {selected && <Check className="h-3 w-3" strokeWidth={3} />}
                  </div>
                  <span className="font-medium text-foreground">{s.hostname}</span>
                  <EnvironmentBadge environment={s.environment} />
                </button>
              );
            })
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-1">Leave empty to match all servers in scope.</p>
      </div>

      <div>
        <label className={labelCls}>Allowed Principals</label>
        <div className="flex gap-2">
          <input
            className={inputCls}
            placeholder="e.g. ubuntu, ec2-user, root"
            value={principalInput}
            onChange={(e) => setPrincipalInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addPrincipal();
              }
            }}
          />
          <button
            type="button"
            onClick={addPrincipal}
            className="flex h-9 items-center gap-1 rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground hover:bg-accent shrink-0"
          >
            <Plus className="h-4 w-4" /> Add
          </button>
        </div>
        {(form.allowedPrincipals || []).length > 0 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {(form.allowedPrincipals || []).map((p) => (
              <Chip key={p} label={p} onRemove={() => removePrincipal(p)} />
            ))}
          </div>
        )}
        {errors.allowedPrincipals && <p className={errorCls}>{errors.allowedPrincipals}</p>}
      </div>

      <div>
        <label className={labelCls}>Target Labels (key/value)</label>
        <div className="flex gap-2">
          <input
            className={inputCls}
            placeholder="Key"
            value={labelKey}
            onChange={(e) => setLabelKey(e.target.value)}
          />
          <input
            className={inputCls}
            placeholder="Value"
            value={labelVal}
            onChange={(e) => setLabelVal(e.target.value)}
          />
          <button
            type="button"
            onClick={addLabel}
            className="flex h-9 items-center gap-1 rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground hover:bg-accent shrink-0"
          >
            <Plus className="h-4 w-4" /> Add
          </button>
        </div>
        {Object.keys(form.targetLabels || {}).length > 0 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {Object.entries(form.targetLabels || {}).map(([k, v]) => (
              <Chip key={k} label={`${k}=${v}`} onRemove={() => removeLabel(k)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Step 4 ─────────────────────────────────────────────────────────────────────
const APPROVER_ROLES = ['admin', 'operator'];

function Step4({ form, onChange, errors }) {
  const durationMinutes = Math.round((form.maxSessionDuration || 3600) / 60);
  const [groups, setGroups] = useState([]);

  useEffect(() => {
    let active = true;
    listGroups()
      .then((res) => {
        if (!active) return;
        const items = res?.items || res?.data?.items || res || [];
        setGroups(Array.isArray(items) ? items : []);
      })
      .catch(() => setGroups([]));
    return () => {
      active = false;
    };
  }, []);

  const toggleApproverRole = (role) => {
    const cur = form.approverRoles || [];
    onChange(
      'approverRoles',
      cur.includes(role) ? cur.filter((r) => r !== role) : [...cur, role]
    );
  };

  return (
    <div className="space-y-5">
      <div>
        <label className={labelCls}>Max Session Duration (minutes)</label>
        <input
          className={inputCls}
          type="number"
          min={1}
          value={durationMinutes}
          onChange={(e) => onChange('maxSessionDuration', Number(e.target.value) * 60)}
        />
        <p className="text-xs text-muted-foreground mt-1">
          Default is 60 minutes (3600 seconds). Value is stored in seconds.
        </p>
        {errors.maxSessionDuration && <p className={errorCls}>{errors.maxSessionDuration}</p>}
      </div>

      <div className="rounded-md border border-border p-4 space-y-4">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={form.requireApproval}
            onChange={(e) => onChange('requireApproval', e.target.checked)}
            className="accent-primary h-4 w-4 mt-0.5 shrink-0"
          />
          <div>
            <span className="text-sm font-medium text-foreground">Require approval</span>
            <p className="text-xs text-muted-foreground mt-0.5">
              Access requests matching this policy will need manager approval before a certificate is issued.
            </p>
          </div>
        </label>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={form.autoApprove}
            onChange={(e) => onChange('autoApprove', e.target.checked)}
            className="accent-primary h-4 w-4 mt-0.5 shrink-0"
          />
          <div>
            <span className="text-sm font-medium text-foreground">Auto-approve</span>
            <p className="text-xs text-muted-foreground mt-0.5">
              Requests are approved automatically without manual review.
            </p>
          </div>
        </label>
      </div>

      {/* Approver routing — who can approve when this policy needs approval */}
      <div className="rounded-md border border-border p-4 space-y-4">
        <div>
          <h4 className="text-sm font-semibold text-foreground">Approvers</h4>
          <p className="text-xs text-muted-foreground mt-0.5">
            Who may approve requests that match this policy (production included). Leave all
            empty to fall back to the requester&apos;s manager. Any one resolved approver can act.
          </p>
        </div>

        <div>
          <label className={labelCls}>Approver group</label>
          <select
            className={inputCls}
            value={form.approverGroupId || ''}
            onChange={(e) => onChange('approverGroupId', e.target.value || null)}
          >
            <option value="">— None —</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelCls}>Approver roles</label>
          <div className="flex flex-wrap gap-3">
            {APPROVER_ROLES.map((role) => (
              <label key={role} className="flex items-center gap-2 text-sm capitalize">
                <input
                  type="checkbox"
                  checked={(form.approverRoles || []).includes(role)}
                  onChange={() => toggleApproverRole(role)}
                  className="accent-primary h-4 w-4"
                />
                {role}
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3">
        <p className="text-xs text-amber-600 dark:text-amber-400 font-medium">
          Production servers always require approval regardless of these settings. This is a hard system rule that cannot be overridden by any policy.
        </p>
      </div>

      {/* Phase 21A — OS Provisioning (JIT user creation) */}
      <div className="rounded-md border border-border p-4 space-y-4">
        <div>
          <h4 className="text-sm font-semibold text-foreground">OS Provisioning (JIT)</h4>
          <p className="text-xs text-muted-foreground mt-0.5">
            When a target host runs the upgraded check-principals agent, it
            will create a per-user Linux account with these settings for the
            duration of the access request.
          </p>
        </div>

        <div>
          <label className={labelCls}>Linux groups (comma-separated)</label>
          <input
            className={inputCls}
            placeholder="docker, webapp"
            value={(form.osProvisioning?.linuxGroups || []).join(', ')}
            onChange={(e) => {
              const groups = e.target.value
                .split(',')
                .map((g) => g.trim())
                .filter(Boolean);
              onChange('osProvisioning', { ...(form.osProvisioning || {}), linuxGroups: groups });
            }}
          />
        </div>

        <div>
          <label className={labelCls}>ACL read paths (comma-separated absolute paths)</label>
          <input
            className={inputCls}
            placeholder="/home/ubuntu, /var/log/app"
            value={(form.osProvisioning?.aclReadPaths || []).join(', ')}
            onChange={(e) => {
              const paths = e.target.value
                .split(',')
                .map((p) => p.trim())
                .filter(Boolean);
              onChange('osProvisioning', { ...(form.osProvisioning || {}), aclReadPaths: paths });
            }}
          />
          <p className="text-xs text-muted-foreground mt-1">
            Grants read access via setfacl without adding the user to a group.
          </p>
        </div>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={!!form.osProvisioning?.aclRecursive}
            onChange={(e) =>
              onChange('osProvisioning', { ...(form.osProvisioning || {}), aclRecursive: e.target.checked })
            }
            className="accent-primary h-4 w-4 mt-0.5 shrink-0"
          />
          <div>
            <span className="text-sm font-medium text-foreground">ACL recursive</span>
            <p className="text-xs text-muted-foreground mt-0.5">
              Apply ACL read access recursively to the paths above (can be slow on large trees).
            </p>
          </div>
        </label>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={!!form.osProvisioning?.sudo}
            onChange={(e) =>
              onChange('osProvisioning', { ...(form.osProvisioning || {}), sudo: e.target.checked })
            }
            className="accent-primary h-4 w-4 mt-0.5 shrink-0"
          />
          <div>
            <span className="text-sm font-medium text-foreground">Grant sudo (NOPASSWD)</span>
            <p className="text-xs text-muted-foreground mt-0.5">
              Writes a sudoers drop-in for the JIT user. Use sparingly.
            </p>
          </div>
        </label>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={!!form.osProvisioning?.hardCutoff}
            onChange={(e) =>
              onChange('osProvisioning', { ...(form.osProvisioning || {}), hardCutoff: e.target.checked })
            }
            className="accent-primary h-4 w-4 mt-0.5 shrink-0"
          />
          <div>
            <span className="text-sm font-medium text-foreground">Hard cutoff on lease expiry</span>
            <p className="text-xs text-muted-foreground mt-0.5">
              Kill active sessions when the lease expires. Default is graceful — active commands finish.
            </p>
          </div>
        </label>
      </div>

      {/* Phase 21A — key download + break-glass flags */}
      <div className="rounded-md border border-border p-4 space-y-4">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={!!form.allowKeyDownload}
            onChange={(e) => onChange('allowKeyDownload', e.target.checked)}
            className="accent-primary h-4 w-4 mt-0.5 shrink-0"
          />
          <div>
            <span className="text-sm font-medium text-foreground">Allow SSH key download</span>
            <p className="text-xs text-muted-foreground mt-0.5">
              Risky. Users can download a short-lived key pair and connect from outside the web terminal. Logged as a distinct audit event.
            </p>
          </div>
        </label>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={!!form.isBreakGlass}
            onChange={(e) => onChange('isBreakGlass', e.target.checked)}
            className="accent-primary h-4 w-4 mt-0.5 shrink-0"
          />
          <div>
            <span className="text-sm font-medium text-foreground">Break-glass policy</span>
            <p className="text-xs text-muted-foreground mt-0.5">
              Marks this as an emergency-access policy. Invoking it notifies all org admins.
            </p>
          </div>
        </label>
      </div>
    </div>
  );
}

// Main PolicyForm ─────────────────────────────────────────────────────────────
function PolicyForm({ open, onClose, onSubmit, policy, onEvaluate }) {
  const isEdit = !!policy;

  const defaultForm = {
    name: '',
    description: '',
    effect: 'ALLOW',
    priority: 1,
    isActive: true,
    subjects: [],
    customerId: null,
    targetEnvironments: [],
    targetServerIds: [],
    allowedPrincipals: [],
    targetLabels: {},
    maxSessionDuration: 3600,
    requireApproval: false,
    autoApprove: false,
    osProvisioning: {
      linuxGroups: [],
      aclReadPaths: [],
      aclRecursive: false,
      sudo: false,
      hardCutoff: false,
    },
    allowKeyDownload: false,
    isBreakGlass: false,
    approverGroupId: null,
    approverRoles: [],
    approverUserIds: [],
  };

  const [form, setForm] = useState(defaultForm);
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [evaluatorOpen, setEvaluatorOpen] = useState(false);

  useEffect(() => {
    if (open) {
      if (policy) {
        setForm({
          name: policy.name || '',
          description: policy.description || '',
          effect: policy.effect || 'ALLOW',
          priority: policy.priority ?? 1,
          isActive: policy.isActive ?? true,
          subjects: (policy.subjects || []).map((s) => ({
            subjectType: s.subjectType,
            subjectId: s.subjectId,
            _label: s.user?.name || s.user?.email || s.group?.name || s.subjectId,
          })),
          customerId: policy.customerId || null,
          targetEnvironments: policy.targetEnvironments || [],
          targetServerIds: policy.targetServerIds || [],
          allowedPrincipals: policy.allowedPrincipals || [],
          targetLabels: policy.targetLabels || {},
          maxSessionDuration: policy.maxSessionDuration ?? 3600,
          requireApproval: policy.requireApproval ?? false,
          autoApprove: policy.autoApprove ?? false,
          osProvisioning: {
            linuxGroups: policy.osProvisioning?.linuxGroups || [],
            aclReadPaths: policy.osProvisioning?.aclReadPaths || [],
            aclRecursive: !!policy.osProvisioning?.aclRecursive,
            sudo: !!policy.osProvisioning?.sudo,
            hardCutoff: !!policy.osProvisioning?.hardCutoff,
          },
          allowKeyDownload: !!policy.allowKeyDownload,
          isBreakGlass: !!policy.isBreakGlass,
          approverGroupId: policy.approverGroupId || null,
          approverRoles: policy.approverRoles || [],
          approverUserIds: policy.approverUserIds || [],
        });
      } else {
        setForm(defaultForm);
      }
      setErrors({});
      setSubmitError('');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, policy]);

  const handleChange = (field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  // Single-pass validation — all sections checked at once on submit.
  const validateAll = () => {
    const errs = {};
    if (!form.name.trim()) errs.name = 'Name is required.';
    if (!form.effect) errs.effect = 'Effect is required.';
    if ((form.subjects || []).length === 0)
      errs.subjects = 'At least one subject (user, group, or role) is required.';
    if ((form.allowedPrincipals || []).length === 0)
      errs.allowedPrincipals = 'At least one allowed principal (e.g. ubuntu) is required.';
    if (!form.maxSessionDuration || form.maxSessionDuration < 60)
      errs.maxSessionDuration = 'Minimum session duration is 1 minute.';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = async () => {
    if (!validateAll()) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        effect: form.effect,
        priority: Math.max(1, Number(form.priority) || 1),
        isActive: form.isActive,
        subjects: (form.subjects || []).map(({ subjectType, subjectId }) => ({
          subjectType,
          subjectId,
        })),
        customerId: form.customerId || undefined,
        targetEnvironments: form.targetEnvironments,
        targetServerIds: form.targetServerIds,
        allowedPrincipals: form.allowedPrincipals,
        targetLabels: form.targetLabels,
        maxSessionDuration: form.maxSessionDuration,
        requireApproval: form.requireApproval,
        autoApprove: form.autoApprove,
        // Phase 21A — JIT provisioning fields must be persisted on save.
        osProvisioning: form.osProvisioning || {},
        allowKeyDownload: !!form.allowKeyDownload,
        isBreakGlass: !!form.isBreakGlass,
        approverGroupId: form.approverGroupId || null,
        approverRoles: form.approverRoles || [],
        approverUserIds: form.approverUserIds || [],
      };
      await onSubmit(payload);
    } catch (err) {
      setSubmitError(err.response?.data?.error?.message || err.message || 'Failed to save policy');
    } finally {
      setSubmitting(false);
    }
  };

  const sectionProps = { form, onChange: handleChange, errors };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit Policy' : 'New Policy'}
      size="lg"
    >
      <div className="space-y-6">
        {/* Live plain-English summary — always visible at the top so the
            user sees what their current choices translate to. */}
        <PolicySummary form={form} />

        {/* All four sections stacked in one scroll view. Each is numbered
            and has a one-line description. No wizard, no Next/Back. */}
        <section>
          <SectionHeader
            number={1}
            title="Basics"
            description="Name, effect (allow or deny), priority, and active state."
          />
          <Step1 {...sectionProps} />
        </section>

        <div className="border-t border-border" />

        <section>
          <SectionHeader
            number={2}
            title="Who does this apply to?"
            description="Pick users, groups, or roles. A role matches every user assigned to it."
          />
          <Step2 {...sectionProps} />
        </section>

        <div className="border-t border-border" />

        <section>
          <SectionHeader
            number={3}
            title="Which servers?"
            description="Scope by customer, environment, specific servers, or label matches."
          />
          <Step3 {...sectionProps} />
        </section>

        <div className="border-t border-border" />

        <section>
          <SectionHeader
            number={4}
            title="Constraints & JIT Provisioning"
            description="Session duration, approval requirements, and optional just-in-time Linux user creation."
          />
          <Step4 {...sectionProps} />
        </section>

        {submitError && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {submitError}
          </div>
        )}

        {Object.keys(errors).length > 0 && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            <Info className="inline h-3 w-3 mr-1" />
            Fix the highlighted fields before saving.
          </div>
        )}

        <div className="flex items-center justify-between border-t border-border pt-4">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-input bg-background px-4 text-sm font-medium text-foreground hover:bg-accent"
          >
            Cancel
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setEvaluatorOpen(true)}
              className="flex h-9 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground hover:bg-accent"
              title="Preview policy evaluation"
            >
              <FlaskConical className="h-3.5 w-3.5" />
              Evaluate
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting}
              className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {submitting ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Policy'}
            </button>
          </div>
        </div>
      </div>

      <PolicyEvaluator
        open={evaluatorOpen}
        onClose={() => setEvaluatorOpen(false)}
        policy={policy || form}
      />
    </Modal>
  );
}

export default PolicyForm;
