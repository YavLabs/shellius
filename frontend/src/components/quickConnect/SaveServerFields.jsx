import { useEffect, useState } from 'react';
import { Info } from 'lucide-react';
import SearchableSelect from '@/components/ui/SearchableSelect';
import { listCustomers } from '@/services/customerService';
import { ENVIRONMENT_LABELS } from '@/lib/labels';

const ENVIRONMENTS = ['demo', 'dev', 'staging', 'prod'];

const inputCls =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';
const labelCls = 'mb-1.5 block text-sm font-medium text-foreground';

/**
 * SaveServerFields — shared "save as server" form fields, used by both
 * QuickConnectModal (save-as-you-connect) and SaveServerModal (save after an
 * already-open Quick Connect terminal session).
 *
 * `identityModes` controls which identity options are offered:
 *   'existing' — use a selected saved identity
 *   'new'      — create a new identity from the auth material just used (admin only, secrets must be in-hand)
 *   'none'     — save as a certificate-mode server (bootstrap later)
 */
function SaveServerFields({
  values,
  onChange,
  identityModes = ['existing', 'new', 'none'],
  identities = [],
  canCreateIdentity = false,
}) {
  const [customers, setCustomers] = useState([]);

  useEffect(() => {
    listCustomers({ page: 1, pageSize: 200, isActive: true })
      .then((data) => setCustomers(data.items || []))
      .catch(() => setCustomers([]));
  }, []);

  const set = (key) => (v) => onChange({ ...values, [key]: v });

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div>
        <label className={labelCls}>Display name</label>
        <input
          className={inputCls}
          value={values.displayName || ''}
          onChange={(e) => set('displayName')(e.target.value)}
          placeholder="Friendly name"
        />
      </div>
      <div>
        <label className={labelCls}>
          Hostname <span className="text-destructive">*</span>
        </label>
        <input
          className={`${inputCls} font-mono`}
          value={values.hostname || ''}
          onChange={(e) => set('hostname')(e.target.value)}
          placeholder="host.example.com or IP"
          required
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>
            Customer <span className="text-destructive">*</span>
          </label>
          <SearchableSelect
            value={values.customerId || ''}
            onChange={set('customerId')}
            options={customers.map((c) => ({ value: c.id, label: c.name }))}
            placeholder="Select customer..."
            clearable={false}
          />
        </div>
        <div>
          <label className={labelCls}>Environment</label>
          <SearchableSelect
            value={values.environment || 'dev'}
            onChange={set('environment')}
            options={ENVIRONMENTS.map((e) => ({ value: e, label: ENVIRONMENT_LABELS[e] || e }))}
            searchable={false}
            clearable={false}
          />
          {values.environment === 'prod' && (
            <p className="mt-1 flex items-start gap-1 text-[11px] text-amber-600 dark:text-amber-400">
              <Info className="mt-0.5 h-3 w-3 shrink-0" />
              Production servers require the access request flow — connecting to this server later
              will need manager approval, even though it was reached via Quick Connect now.
            </p>
          )}
        </div>
      </div>
      <div>
        <label className={labelCls}>Description</label>
        <textarea
          rows={2}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          value={values.description || ''}
          onChange={(e) => set('description')(e.target.value)}
        />
      </div>

      <div>
        <label className={labelCls}>Credentials</label>
        <div className="space-y-1.5">
          {identityModes.includes('existing') && (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
              <input
                type="radio"
                checked={values.identityMode === 'existing'}
                onChange={() => set('identityMode')('existing')}
              />
              Use selected identity
            </label>
          )}
          {values.identityMode === 'existing' && identityModes.includes('existing') && (
            <div className="ml-6">
              <SearchableSelect
                value={values.identityId || ''}
                onChange={set('identityId')}
                options={identities.map((c) => ({ value: c.id, label: c.name, sublabel: c.username }))}
                placeholder="Select an identity..."
                clearable={false}
              />
            </div>
          )}
          {identityModes.includes('new') && canCreateIdentity && (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
              <input
                type="radio"
                checked={values.identityMode === 'new'}
                onChange={() => set('identityMode')('new')}
              />
              Save these credentials as a new identity
            </label>
          )}
          {values.identityMode === 'new' && identityModes.includes('new') && canCreateIdentity && (
            <div className="ml-6">
              <input
                className={inputCls}
                value={values.newIdentityName || ''}
                onChange={(e) => set('newIdentityName')(e.target.value)}
                placeholder="Identity name"
              />
            </div>
          )}
          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <input
              type="radio"
              checked={values.identityMode === 'none'}
              onChange={() => set('identityMode')('none')}
            />
            Don&apos;t store credentials (certificate mode, bootstrap later)
          </label>
        </div>
      </div>
    </div>
  );
}

export default SaveServerFields;
