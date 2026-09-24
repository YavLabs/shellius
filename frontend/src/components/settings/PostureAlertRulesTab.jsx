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
  { value: 'chat', label: 'Chat' },
];

const MODES = [
  { value: 'immediate', label: 'Send each finding as it happens' },
  { value: 'digest', label: 'Batch the email into a digest' },
];

const DIGEST_SCHEDULES = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
];

const WEEKDAYS = [
  { value: 0, label: 'Sunday' },
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
];

const HOURS = Array.from({ length: 24 }, (_, h) => ({
  value: h,
  label: `${String(h).padStart(2, '0')}:00 UTC`,
}));

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
  digestSchedule: 'daily',
  digestHour: 8,
  digestDayOfWeek: 1,
  throttleMinutes: 0,
  escalateAfterHours: '',
  escalateToGroupId: '',
};

/**
 * "email digest daily 08:00 UTC" — mirrors the backend's normalisation, which
 * reads a NULL cadence as daily at 08:00 (and deliberately does NOT coerce
 * NULL to 0, because that would mean midnight).
 */
function digestLabel(rule) {
  const hour = Number.isInteger(rule.digestHour) ? rule.digestHour : 8;
  const at = `${String(hour).padStart(2, '0')}:00 UTC`;
  if (rule.digestSchedule === 'weekly') {
    const day = WEEKDAYS.find((d) => d.value === rule.digestDayOfWeek)?.label || 'Monday';
    return `email digest ${day} ${at}`;
  }
  return `email digest daily ${at}`;
}

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
      digestHour: Number(form.digestHour) || 0,
      // The API refuses a day on a daily schedule, and the backend's
      // normaliser would pick Monday for a weekly rule that sent none.
      digestDayOfWeek: form.digestSchedule === 'weekly' ? Number(form.digestDayOfWeek) || 0 : null,
    });
  };

  const isDigest = form.mode === 'digest';
  const hasEmail = form.channels.includes('email');

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

      <Field label="Channels" description="Chat goes to whichever chat destinations subscribe to posture findings (Administration → Chat notifications).">
        <SearchableSelect
          multiple
          value={form.channels}
          onChange={(v) => set({ channels: v })}
          options={CHANNELS}
          placeholder="Choose at least one"
          searchable={false}
        />
      </Field>

      {/* Digest batches the EMAIL channel and nothing else. The first version
          of this control suppressed the only channel a rule had and deferred
          to a job that was never written, so those rules delivered nothing at
          all. Saying exactly what is and is not batched is what stops that
          being re-learned the hard way. */}
      <Field
        label="Email delivery"
        description="In-app and chat always arrive as each finding happens. This only changes the email."
      >
        <SearchableSelect
          value={form.mode}
          onChange={(v) => set({ mode: v })}
          options={MODES}
          searchable={false}
        />
      </Field>

      {isDigest && !hasEmail && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          This rule has no email channel, so there is nothing to batch. Add
          &ldquo;Email&rdquo; above, or leave the mode on &ldquo;send each finding&rdquo;.
        </div>
      )}

      {isDigest && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="How often">
            <SearchableSelect
              value={form.digestSchedule}
              onChange={(v) => set({ digestSchedule: v })}
              options={DIGEST_SCHEDULES}
              searchable={false}
            />
          </Field>
          {form.digestSchedule === 'weekly' && (
            <Field label="Day">
              <SearchableSelect
                value={form.digestDayOfWeek}
                onChange={(v) => set({ digestDayOfWeek: v })}
                options={WEEKDAYS}
                searchable={false}
              />
            </Field>
          )}
          <Field label="At" description="Always UTC">
            <SearchableSelect
              value={form.digestHour}
              onChange={(v) => set({ digestHour: v })}
              options={HOURS}
              searchable={false}
            />
          </Field>
        </div>
      )}

      <Field
        label="Throttle (minutes)"
        description={
          isDigest
            ? 'Per finding, 0 = none. Applies to the in-app and chat channels; the digest is bounded by its own schedule.'
            : 'Per finding, 0 = none'
        }
      >
        <Input type="number" min={0} value={form.throttleMinutes} onChange={(e) => set({ throttleMinutes: e.target.value })} />
      </Field>

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
            // Worth showing in the list: a rule whose email is batched
            // behaves very differently from one that is not, and the only
            // other way to find out is to open it.
            rule.mode === 'digest' ? digestLabel(rule) : null,
            rule.throttleMinutes ? `throttled ${rule.throttleMinutes}m` : null,
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
          rule={
            editing
              ? {
                  ...EMPTY_RULE,
                  ...editing,
                  escalateAfterHours: editing.escalateAfterHours ?? '',
                  // Rules written before digest existed carry NULLs here, and
                  // a spread of null would blank the selects rather than fall
                  // back to EMPTY_RULE's defaults.
                  digestSchedule: editing.digestSchedule ?? EMPTY_RULE.digestSchedule,
                  digestHour: editing.digestHour ?? EMPTY_RULE.digestHour,
                  digestDayOfWeek: editing.digestDayOfWeek ?? EMPTY_RULE.digestDayOfWeek,
                }
              : EMPTY_RULE
          }
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
