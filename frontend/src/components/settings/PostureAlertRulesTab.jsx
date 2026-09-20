import { useEffect, useState } from 'react';
import { BellRing, Pencil, Plus, Trash2 } from 'lucide-react';
import { SectionCard } from '@/components/settings/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Modal from '@/components/shared/Modal';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { SwitchField } from '@/components/ui/switch';
import SearchableSelect from '@/components/ui/SearchableSelect';
import EmptyState from '@/components/ui/EmptyState';
import {
  listAlertRules,
  createAlertRule,
  updateAlertRule,
  deleteAlertRule,
} from '@/services/postureService';
import { listCustomers } from '@/services/customerService';
import { listGroups } from '@/services/groupService';
import { severityTone } from '@/lib/badgeTones';
import { ROLE_LABELS } from '@/lib/permissions';

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const ENVIRONMENTS = ['demo', 'dev', 'staging', 'prod'];
const BASE_TIERS = ['member', 'manager', 'admin', 'super_admin'];
const CHANNELS = [
  { value: 'inapp', label: 'In-app' },
  { value: 'email', label: 'Email' },
];

const EMPTY_RULE = {
  name: '',
  isActive: true,
  severities: [],
  codes: [],
  customerIds: [],
  environments: [],
  recipientRoles: [],
  recipientGroupId: '',
  recipientUserIds: [],
  channels: ['inapp'],
  mode: 'immediate',
  throttleMinutes: 0,
  escalateAfterHours: '',
  escalateToGroupId: '',
};

function Field({ label, description, children }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
      {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
    </div>
  );
}

function RuleForm({ rule, customers, groups, onSave, onCancel, saving, error }) {
  const [form, setForm] = useState(rule);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const handleSubmit = () => {
    onSave({
      ...form,
      throttleMinutes: Number(form.throttleMinutes) || 0,
      escalateAfterHours: form.escalateAfterHours === '' ? null : Number(form.escalateAfterHours),
      recipientGroupId: form.recipientGroupId || null,
      escalateToGroupId: form.escalateToGroupId || null,
    });
  };

  const canSubmit = form.name.trim().length > 0 && form.channels.length > 0;

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <Field label="Name">
        <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder='e.g. "Critical exposure"' />
      </Field>

      <SwitchField label="Active" checked={form.isActive} onCheckedChange={(v) => set({ isActive: v })} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Severities" description="Empty = any severity">
          <SearchableSelect
            multiple
            value={form.severities}
            onChange={(v) => set({ severities: v })}
            options={SEVERITIES.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }))}
            placeholder="Any severity"
            searchable={false}
          />
        </Field>
        <Field label="Environments" description="Empty = any environment">
          <SearchableSelect
            multiple
            value={form.environments}
            onChange={(v) => set({ environments: v })}
            options={ENVIRONMENTS.map((e) => ({ value: e, label: e }))}
            placeholder="Any environment"
            searchable={false}
          />
        </Field>
      </div>

      <Field label="Customers" description="Empty = any customer">
        <SearchableSelect
          multiple
          value={form.customerIds}
          onChange={(v) => set({ customerIds: v })}
          options={customers.map((c) => ({ value: c.id, label: c.name }))}
          placeholder="Any customer"
        />
      </Field>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Recipient roles">
          <SearchableSelect
            multiple
            value={form.recipientRoles}
            onChange={(v) => set({ recipientRoles: v })}
            options={BASE_TIERS.map((t) => ({ value: t, label: ROLE_LABELS[t] || t }))}
            placeholder="No roles"
            searchable={false}
          />
        </Field>
        <Field label="Recipient group">
          <SearchableSelect
            value={form.recipientGroupId}
            onChange={(v) => set({ recipientGroupId: v })}
            options={groups.map((g) => ({ value: g.id, label: g.name }))}
            placeholder="No group"
          />
        </Field>
      </div>

      <Field label="Channels">
        <SearchableSelect
          multiple
          value={form.channels}
          onChange={(v) => set({ channels: v })}
          options={CHANNELS}
          placeholder="Choose at least one"
          searchable={false}
        />
      </Field>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Mode">
          <SearchableSelect
            value={form.mode}
            onChange={(v) => set({ mode: v })}
            options={[
              { value: 'immediate', label: 'Immediate' },
              { value: 'digest', label: 'Daily digest' },
            ]}
            searchable={false}
            clearable={false}
          />
        </Field>
        <Field label="Throttle (minutes)" description="Per finding, 0 = none">
          <Input type="number" min={0} value={form.throttleMinutes} onChange={(e) => set({ throttleMinutes: e.target.value })} />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Escalate after (hours)" description="Blank = never">
          <Input type="number" min={1} value={form.escalateAfterHours} onChange={(e) => set({ escalateAfterHours: e.target.value })} />
        </Field>
        <Field label="Escalate to group">
          <SearchableSelect
            value={form.escalateToGroupId}
            onChange={(v) => set({ escalateToGroupId: v })}
            options={groups.map((g) => ({ value: g.id, label: g.name }))}
            placeholder="No escalation group"
            disabled={!form.escalateAfterHours}
          />
        </Field>
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={!canSubmit || saving}>
          {saving ? 'Saving…' : 'Save rule'}
        </Button>
      </div>
    </div>
  );
}

function RuleRow({ rule, onEdit, onDelete }) {
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium text-foreground">{rule.name}</span>
          {!rule.isActive && <Badge tone="neutral">Inactive</Badge>}
          {(rule.severities || []).length === 0 ? (
            <Badge tone="neutral" variant="outline">Any severity</Badge>
          ) : (
            rule.severities.map((s) => (
              <Badge key={s} tone={severityTone(s).tone} variant={severityTone(s).variant}>
                {severityTone(s).label}
              </Badge>
            ))
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {[
            (rule.recipientRoles || []).length ? `roles: ${rule.recipientRoles.join(', ')}` : null,
            rule.recipientGroupId ? 'group recipient' : null,
            (rule.channels || []).join(', '),
            rule.mode === 'digest' ? 'daily digest' : 'immediate',
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onEdit(rule)} aria-label="Edit rule">
          <Pencil className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => onDelete(rule)} aria-label="Delete rule">
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </li>
  );
}

/**
 * Administration → Organization → Posture → Alert rules (spec §6). Routing
 * is rule-based, not a hard-coded admin list — a fresh org ships with one
 * seeded rule (server-side default) for critical findings to admins.
 */
function PostureAlertRulesTab() {
  const [rules, setRules] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [ruleList, customerData, groupData] = await Promise.all([
        listAlertRules(),
        listCustomers({ page: 1, pageSize: 200 }).catch(() => ({ items: [] })),
        listGroups().catch(() => []),
      ]);
      setRules(ruleList || []);
      setCustomers(customerData.items || []);
      setGroups(groupData || []);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load alert rules');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const openNew = () => {
    setEditing(null);
    setFormError('');
    setFormOpen(true);
  };
  const openEdit = (rule) => {
    setEditing(rule);
    setFormError('');
    setFormOpen(true);
  };

  const handleSave = async (payload) => {
    setSaving(true);
    setFormError('');
    try {
      if (editing) await updateAlertRule(editing.id, payload);
      else await createAlertRule(payload);
      setFormOpen(false);
      setEditing(null);
      load();
    } catch (err) {
      setFormError(err.response?.data?.error?.message || 'Failed to save rule');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteAlertRule(deleteTarget.id);
      setDeleteTarget(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to delete rule');
      setDeleteTarget(null);
    }
  };

  return (
    <SectionCard
      title="Posture — Alert rules"
      description="Who gets told when a finding opens, reopens, or is still open at escalation time. A muted finding never notifies, including escalations."
      actions={
        <Button size="sm" onClick={openNew}>
          <Plus className="mr-1.5 h-4 w-4" /> New rule
        </Button>
      }
    >
      {error && (
        <div className="mb-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="h-32 animate-pulse rounded bg-muted" />
      ) : rules.length === 0 ? (
        <EmptyState
          icon={BellRing}
          title="No alert rules yet"
          description="Without a rule, nobody is notified when a finding opens. Add one to route critical exposure to the right people."
          action={{ label: 'New rule', onClick: openNew }}
        />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {rules.map((r) => (
            <RuleRow key={r.id} rule={r} onEdit={openEdit} onDelete={setDeleteTarget} />
          ))}
        </ul>
      )}

      <Modal open={formOpen} onClose={() => setFormOpen(false)} title={editing ? 'Edit alert rule' : 'New alert rule'} size="lg">
        <RuleForm
          rule={editing ? { ...EMPTY_RULE, ...editing, escalateAfterHours: editing.escalateAfterHours ?? '' } : EMPTY_RULE}
          customers={customers}
          groups={groups}
          onSave={handleSave}
          onCancel={() => setFormOpen(false)}
          saving={saving}
          error={formError}
        />
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete alert rule"
        message={`Delete "${deleteTarget?.name}"? Findings that would have matched it stop notifying its recipients.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </SectionCard>
  );
}

export default PostureAlertRulesTab;
