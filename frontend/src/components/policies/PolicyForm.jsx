import { useState, useEffect, useCallback } from 'react';
import { X, Plus } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import { listUsers } from '@/services/userService';
import { listGroups } from '@/services/groupService';
import { listCustomers } from '@/services/customerService';
import { listServers } from '@/services/serverService';

const ENVIRONMENTS = ['demo', 'dev', 'staging', 'prod'];
const STEPS = ['Basics', 'Subjects', 'Targets', 'Constraints'];

const inputCls =
  'w-full h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';
const labelCls = 'block text-sm font-medium text-foreground mb-1';
const errorCls = 'text-xs text-destructive mt-1';

function StepIndicator({ current }) {
  return (
    <div className="flex items-center gap-0 mb-6">
      {STEPS.map((label, i) => {
        const num = i + 1;
        const active = current === num;
        const done = current > num;
        return (
          <div key={label} className="flex items-center">
            <div className="flex items-center gap-2">
              <div
                className={[
                  'flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold',
                  done
                    ? 'bg-primary text-primary-foreground'
                    : active
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground',
                ].join(' ')}
              >
                {num}
              </div>
              <span
                className={[
                  'text-xs font-medium',
                  active ? 'text-foreground' : 'text-muted-foreground',
                ].join(' ')}
              >
                {label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div
                className={[
                  'mx-3 h-px w-10 flex-shrink-0',
                  done ? 'bg-primary' : 'bg-border',
                ].join(' ')}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

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
            min={0}
            value={form.priority}
            onChange={(e) => onChange('priority', Number(e.target.value))}
          />
          <p className="text-xs text-muted-foreground mt-1">Higher priority evaluates first.</p>
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
  const [users, setUsers] = useState([]);
  const [groups, setGroups] = useState([]);
  const [userSearch, setUserSearch] = useState('');
  const [groupSearch, setGroupSearch] = useState('');
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [loadingGroups, setLoadingGroups] = useState(false);

  useEffect(() => {
    setLoadingUsers(true);
    listUsers({ page: 1, pageSize: 200 })
      .then((d) => setUsers(d.items || d || []))
      .catch(() => setUsers([]))
      .finally(() => setLoadingUsers(false));
  }, []);

  useEffect(() => {
    setLoadingGroups(true);
    listGroups()
      .then((d) => setGroups(Array.isArray(d) ? d : d.items || []))
      .catch(() => setGroups([]))
      .finally(() => setLoadingGroups(false));
  }, []);

  const subjects = form.subjects || [];

  const addSubject = (type, id, label) => {
    const exists = subjects.find((s) => s.subjectType === type && s.subjectId === id);
    if (exists) return;
    onChange('subjects', [...subjects, { subjectType: type, subjectId: id, _label: label }]);
  };

  const removeSubject = (type, id) => {
    onChange('subjects', subjects.filter((s) => !(s.subjectType === type && s.subjectId === id)));
  };

  const filteredUsers = users.filter((u) => {
    const q = userSearch.toLowerCase();
    return (
      !q ||
      (u.name || '').toLowerCase().includes(q) ||
      (u.email || '').toLowerCase().includes(q)
    );
  });

  const filteredGroups = groups.filter((g) => {
    const q = groupSearch.toLowerCase();
    return !q || (g.name || '').toLowerCase().includes(q);
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Choose which users and groups this policy applies to.
      </p>

      {subjects.length > 0 && (
        <div className="flex flex-wrap gap-2 rounded-md border border-border bg-muted/30 p-3">
          {subjects.map((s) => (
            <Chip
              key={`${s.subjectType}-${s.subjectId}`}
              label={`${s._label || s.subjectId} (${s.subjectType === 'USER' ? 'User' : 'Group'})`}
              onRemove={() => removeSubject(s.subjectType, s.subjectId)}
            />
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelCls}>Users</label>
          <input
            className={inputCls}
            placeholder="Search users..."
            value={userSearch}
            onChange={(e) => setUserSearch(e.target.value)}
          />
          <div className="mt-1 max-h-40 overflow-y-auto rounded-md border border-border">
            {loadingUsers ? (
              <p className="p-2 text-xs text-muted-foreground">Loading...</p>
            ) : filteredUsers.length === 0 ? (
              <p className="p-2 text-xs text-muted-foreground">No users found</p>
            ) : (
              filteredUsers.map((u) => {
                const selected = subjects.some(
                  (s) => s.subjectType === 'USER' && s.subjectId === u.id
                );
                return (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => {
                      if (selected) {
                        removeSubject('USER', u.id);
                      } else {
                        addSubject('USER', u.id, u.name || u.email);
                      }
                    }}
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
                      {selected && <span className="text-[10px] font-bold">✓</span>}
                    </div>
                    <span className="font-medium text-foreground">{u.name || u.email}</span>
                    {u.name && <span className="text-muted-foreground">{u.email}</span>}
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div>
          <label className={labelCls}>Groups</label>
          <input
            className={inputCls}
            placeholder="Search groups..."
            value={groupSearch}
            onChange={(e) => setGroupSearch(e.target.value)}
          />
          <div className="mt-1 max-h-40 overflow-y-auto rounded-md border border-border">
            {loadingGroups ? (
              <p className="p-2 text-xs text-muted-foreground">Loading...</p>
            ) : filteredGroups.length === 0 ? (
              <p className="p-2 text-xs text-muted-foreground">No groups found</p>
            ) : (
              filteredGroups.map((g) => {
                const selected = subjects.some(
                  (s) => s.subjectType === 'GROUP' && s.subjectId === g.id
                );
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => {
                      if (selected) {
                        removeSubject('GROUP', g.id);
                      } else {
                        addSubject('GROUP', g.id, g.name);
                      }
                    }}
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
                      {selected && <span className="text-[10px] font-bold">✓</span>}
                    </div>
                    <span className="font-medium text-foreground">{g.name}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>

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
                    {selected && <span className="text-[10px] font-bold">✓</span>}
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
function Step4({ form, onChange, errors }) {
  const durationMinutes = Math.round((form.maxSessionDuration || 3600) / 60);

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

      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3">
        <p className="text-xs text-amber-600 dark:text-amber-400 font-medium">
          Production servers always require manager approval regardless of these settings. This is a hard system rule that cannot be overridden by any policy.
        </p>
      </div>
    </div>
  );
}

// Main PolicyForm ─────────────────────────────────────────────────────────────
function PolicyForm({ open, onClose, onSubmit, policy }) {
  const isEdit = !!policy;

  const defaultForm = {
    name: '',
    description: '',
    effect: 'ALLOW',
    priority: 0,
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
  };

  const [step, setStep] = useState(1);
  const [form, setForm] = useState(defaultForm);
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  useEffect(() => {
    if (open) {
      if (policy) {
        setForm({
          name: policy.name || '',
          description: policy.description || '',
          effect: policy.effect || 'ALLOW',
          priority: policy.priority ?? 0,
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
        });
      } else {
        setForm(defaultForm);
      }
      setStep(1);
      setErrors({});
      setSubmitError('');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, policy]);

  const handleChange = (field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validateStep = () => {
    const errs = {};
    if (step === 1) {
      if (!form.name.trim()) errs.name = 'Name is required.';
      if (!form.effect) errs.effect = 'Effect is required.';
    }
    if (step === 2) {
      if ((form.subjects || []).length === 0)
        errs.subjects = 'At least one subject (user or group) is required.';
    }
    if (step === 3) {
      if ((form.allowedPrincipals || []).length === 0)
        errs.allowedPrincipals = 'At least one allowed principal (e.g. ubuntu) is required.';
    }
    if (step === 4) {
      if (!form.maxSessionDuration || form.maxSessionDuration < 60)
        errs.maxSessionDuration = 'Minimum session duration is 1 minute.';
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleNext = () => {
    if (validateStep()) setStep((s) => s + 1);
  };

  const handleBack = () => {
    setErrors({});
    setStep((s) => s - 1);
  };

  const handleSubmit = async () => {
    if (!validateStep()) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        effect: form.effect,
        priority: form.priority,
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
      };
      await onSubmit(payload);
    } catch (err) {
      setSubmitError(err.response?.data?.error?.message || err.message || 'Failed to save policy');
    } finally {
      setSubmitting(false);
    }
  };

  const stepProps = { form, onChange: handleChange, errors };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit Policy' : 'New Policy'}
      size="lg"
    >
      <StepIndicator current={step} />

      {step === 1 && <Step1 {...stepProps} />}
      {step === 2 && <Step2 {...stepProps} />}
      {step === 3 && <Step3 {...stepProps} />}
      {step === 4 && <Step4 {...stepProps} />}

      {submitError && (
        <div className="mt-4 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {submitError}
        </div>
      )}

      <div className="mt-6 flex items-center justify-between">
        <button
          type="button"
          onClick={step === 1 ? onClose : handleBack}
          className="h-9 rounded-md border border-input bg-background px-4 text-sm font-medium text-foreground hover:bg-accent"
        >
          {step === 1 ? 'Cancel' : 'Back'}
        </button>
        {step < STEPS.length ? (
          <button
            type="button"
            onClick={handleNext}
            className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Next
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {submitting ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Policy'}
          </button>
        )}
      </div>
    </Modal>
  );
}

export default PolicyForm;
