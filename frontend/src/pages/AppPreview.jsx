import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Eye,
  Info,
  KeyRound,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Terminal,
  Trash2,
  XCircle,
  Zap,
} from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { AuthContext } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import PageHeader from '@/components/common/PageHeader';
import DataTable from '@/components/shared/DataTable';
import Modal from '@/components/shared/Modal';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import HealthStatusDot from '@/components/shared/HealthStatusDot';
import EmptyState from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { SwitchField } from '@/components/ui/switch';
import SearchableSelect from '@/components/ui/SearchableSelect';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/**
 * /dummy/app — the real app frame (sidebar, top bar, footer) around a page of
 * sample content that exercises the UI kit: metric cards, tabs, filters, a
 * selectable data grid with bulk actions and row menus, forms, switches,
 * badges, alerts, menus, empty state and modals. "New look" adds the
 * proposed theme (`theme-fey` in index.css) to <html>; "Current" shows
 * today's. Like the other /dummy pages, the API client never reaches the
 * server here (lib/previewMock.js) and the session is fake.
 */

// Every permission check passes, so the whole sidebar shows.
const ALL = Object.assign([], { includes: () => true });
const SESSION = {
  user: {
    id: 'preview-user',
    email: 'alex.morgan@example.com',
    name: 'Alex Morgan',
    role: 'admin',
    roleInfo: { key: 'admin', name: 'Admin', isSystem: true, baseRole: 'admin' },
    orgName: 'Acme Corp',
    organization: { name: 'Acme Corp' },
    permissions: ALL,
    features: { personalVault: true },
  },
  accessToken: null,
  isLoading: false,
  loading: false,
  error: null,
  isAuthenticated: true,
  can: () => true,
  login: async () => {},
  loginWithTokens: async () => {},
  completeMfa: async () => {},
  applyAuthResult: () => {},
  applyTokenPair: () => {},
  clearSession: () => {},
  refreshUser: async () => null,
  logout: () => {},
  refresh: async () => {},
};

const SERVERS = [
  ['prod-db-01', 'db-01.acme.internal', '10.20.1.11', 'Acme Corp', 'prod', 'SSH', 'healthy', 'linux'],
  ['prod-api-02', 'api-02.acme.internal', '10.20.1.12', 'Acme Corp', 'prod', 'SSH', 'healthy', 'linux'],
  ['stg-web-01', 'web-01.stg.globex.io', '10.31.4.20', 'Globex', 'staging', 'SSH', 'unknown', 'linux'],
  ['dev-worker-07', 'worker-07.dev.initech', '10.42.8.7', 'Initech', 'dev', 'SSH', 'healthy', 'linux'],
  ['demo-win-03', 'win-03.demo.umbrella', '10.43.2.3', 'Umbrella', 'demo', 'RDP', 'unhealthy', 'windows'],
  ['prod-bastion', 'bastion.stark.internal', '10.44.0.2', 'Stark Industries', 'prod', 'SSH', 'healthy', 'linux'],
  ['dev-cache-12', 'cache-12.dev.wayne', '10.45.3.12', 'Wayne Enterprises', 'dev', 'BOTH', 'maintenance', 'linux'],
  ['stg-queue-04', 'queue-04.stg.acme', '10.20.6.4', 'Acme Corp', 'staging', 'SSH', 'healthy', 'linux'],
].map(([displayName, hostname, ipAddress, customer, environment, protocol, healthStatus, osType], i) => ({
  id: `srv-${i}`,
  displayName,
  hostname,
  ipAddress,
  customer,
  environment,
  protocol,
  healthStatus,
  osType,
  lastCheck: ['just now', '2 min ago', '4 min ago', '11 min ago', '1 hr ago', 'just now', '3 hr ago', '6 min ago'][i],
}));

const ENV_OPTIONS = [
  { value: '', label: 'All environments' },
  { value: 'prod', label: 'Production' },
  { value: 'staging', label: 'Staging' },
  { value: 'dev', label: 'Development' },
  { value: 'demo', label: 'Demo' },
];

function Card({ title, subtitle, action, children, className }) {
  return (
    <section className={cn('rounded-lg border border-border bg-card', className)}>
      {(title || action) && (
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

function Metric({ icon: Icon, label, value, hint, tone }) {
  const tones = {
    indigo: 'bg-indigo-500/10 text-indigo-500 dark:text-indigo-300',
    emerald: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
    amber: 'bg-amber-500/10 text-amber-600 dark:text-amber-300',
    sky: 'bg-sky-500/10 text-sky-600 dark:text-sky-300',
  };
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className={cn('flex h-8 w-8 items-center justify-center rounded-md', tones[tone])}>
            <Icon className="h-4 w-4" />
          </span>
          <span className="text-sm text-muted-foreground">{label}</span>
        </div>
        <span className="text-2xl font-semibold tabular-nums text-foreground">{value}</span>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function Alert({ tone, icon: Icon, children }) {
  const tones = {
    info: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
    success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    warning: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
    danger: 'border-destructive/40 bg-destructive/10 text-destructive',
  };
  return (
    <div className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-sm', tones[tone])}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function PreviewContent() {
  const [tab, setTab] = useState('servers');
  const [env, setEnv] = useState('');
  const [selected, setSelected] = useState(['srv-1']);
  const [formOpen, setFormOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [auth, setAuth] = useState('key');
  const [bypass, setBypass] = useState(true);
  const [record, setRecord] = useState(false);
  const [agree, setAgree] = useState(true);
  const [customer, setCustomer] = useState('acme');

  const rows = useMemo(() => SERVERS.filter((s) => !env || s.environment === env), [env]);

  const columns = [
    {
      key: 'name',
      label: 'Name',
      sortable: true,
      searchAccessor: (r) => `${r.displayName} ${r.hostname}`,
      render: (r) => (
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground">{r.displayName}</div>
            <div className="truncate font-mono text-xs text-muted-foreground">{r.hostname}</div>
          </div>
        </div>
      ),
    },
    { key: 'ipAddress', label: 'IP', sortable: true, render: (r) => <span className="font-mono text-xs">{r.ipAddress}</span> },
    { key: 'customer', label: 'Customer', sortable: true },
    { key: 'environment', label: 'Env', sortable: true, render: (r) => <EnvironmentBadge environment={r.environment} /> },
    { key: 'protocol', label: 'Protocol', sortable: true },
    { key: 'health', label: 'Health', render: (r) => <HealthStatusDot status={r.healthStatus} showLabel /> },
    { key: 'lastCheck', label: 'Last check', hideBelow: 'lg', render: (r) => <span className="text-xs text-muted-foreground">{r.lastCheck}</span> },
    {
      key: 'connect',
      label: '',
      render: () => (
        <Button size="sm" variant="outline" className="gap-1.5">
          <KeyRound className="h-3.5 w-3.5" /> Request access
        </Button>
      ),
    },
    {
      key: 'actions',
      label: '',
      className: 'w-10',
      actions: [
        { label: 'View details', icon: Eye, onClick: () => {} },
        { label: 'Edit', icon: Pencil, onClick: () => setFormOpen(true) },
        { label: 'Delete', icon: Trash2, onClick: () => setConfirmOpen(true), variant: 'destructive', separator: true },
      ],
    },
  ];

  return (
    <div className="space-y-6 p-6">
      <PageHeader icon={Server} title="Servers" subtitle="Manage target servers across customers.">
        <Button variant="outline" className="gap-2">
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
        <Button variant="outline" className="gap-2">
          <Zap className="h-4 w-4" /> Quick connect
        </Button>
        <Button className="gap-2" onClick={() => setFormOpen(true)}>
          <Plus className="h-4 w-4" /> Add server
        </Button>
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric icon={Server} label="Total servers" value="31" hint="7 prod · 7 staging · 9 dev · 8 demo" tone="indigo" />
        <Metric icon={Terminal} label="Active sessions" value="4" hint="2 recorded right now" tone="emerald" />
        <Metric icon={KeyRound} label="Pending requests" value="3" hint="1 is for a prod server" tone="amber" />
        <Metric icon={ShieldCheck} label="Certificates" value="12" hint="All signed by the org CA" tone="sky" />
      </div>

      <div className="flex items-center gap-1 border-b border-border">
        {[
          ['servers', 'Servers'],
          ['sessions', 'Sessions'],
          ['empty', 'Empty state'],
        ].map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              'px-4 py-2.5 text-sm font-medium transition-colors',
              tab === key ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'empty' ? (
        <EmptyState
          icon={Lock}
          title="No hosts yet"
          description="My hosts is your own private SSH address book. Nobody else, not even admins, can see these entries."
          action={{ label: 'Add host', onClick: () => setFormOpen(true) }}
        />
      ) : (
        <DataTable
          columns={columns}
          data={tab === 'sessions' ? rows.slice(0, 4) : rows}
          searchPlaceholder="Search name, hostname or IP…"
          selectable
          selectedIds={selected}
          onSelectionChange={setSelected}
          filters={
            <div className="w-48">
              <SearchableSelect value={env} onChange={setEnv} options={ENV_OPTIONS} searchable={false} clearable={false} />
            </div>
          }
          bulkActions={
            <>
              <Button size="sm" variant="outline">
                Change environment
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5 text-destructive" onClick={() => setConfirmOpen(true)}>
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </Button>
            </>
          }
          defaultPageSize={10}
        />
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Server settings" subtitle="Inputs, selects, choice cards, switches and checkboxes.">
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <label className="mb-1.5 block text-sm font-medium">Hostname</label>
                <input
                  defaultValue="db-01.acme.internal"
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium">Port</label>
                <input
                  defaultValue="22"
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">Customer</label>
              <SearchableSelect
                value={customer}
                onChange={setCustomer}
                options={[
                  { value: 'acme', label: 'Acme Corp' },
                  { value: 'globex', label: 'Globex' },
                  { value: 'initech', label: 'Initech' },
                ]}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">Authentication</label>
              <div className="grid gap-2 sm:grid-cols-2">
                {[
                  ['key', 'Certificate', 'Short-lived certs from the org CA.'],
                  ['password', 'Stored identity', 'A Keystore identity for hosts without the agent.'],
                ].map(([value, title, desc]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setAuth(value)}
                    className={cn(
                      'rounded-md border p-3 text-left transition-colors',
                      auth === value ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/50'
                    )}
                  >
                    <div className="text-sm font-medium text-foreground">{title}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{desc}</div>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">Notes</label>
              <textarea
                rows={2}
                placeholder="Anything the on-call engineer should know"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <SwitchField
              label="Production approval bypass"
              description="Admins may skip approval on prod (still audited)."
              checked={bypass}
              onCheckedChange={setBypass}
              bordered
            />
            <SwitchField label="Record sessions" description="Store terminal recordings for 30 days." checked={record} onCheckedChange={setRecord} bordered />
            <label className="flex items-center gap-2 text-sm text-foreground">
              <Checkbox checked={agree} onChange={(e) => setAgree(e.target.checked)} />
              Notify the server's approvers
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline">Cancel</Button>
              <Button>Save changes</Button>
            </div>
          </div>
        </Card>

        <div className="space-y-6">
          <Card title="Buttons & badges">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Variants</p>
            <div className="flex flex-wrap gap-2">
              <Button>Primary</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="destructive">Destructive</Button>
              <Button variant="link">Link</Button>
            </div>
            <p className="mb-2 mt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">Sizes &amp; states</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm">Small</Button>
              <Button>Default</Button>
              <Button size="lg">Large</Button>
              <Button disabled>Disabled</Button>
              <Button variant="outline" disabled>
                Disabled
              </Button>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Badge tone="neutral">Neutral</Badge>
              <Badge tone="success">Approved</Badge>
              <Badge tone="warning">Pending</Badge>
              <Badge tone="danger">Denied</Badge>
              <Badge tone="info">Info</Badge>
              <Badge tone="accent">Accent</Badge>
              <Badge tone="success" dot>
                Healthy
              </Badge>
              <Badge tone="info" variant="outline">
                Outline
              </Badge>
              <EnvironmentBadge environment="prod" />
              <EnvironmentBadge environment="staging" />
              <EnvironmentBadge environment="dev" />
              <EnvironmentBadge environment="demo" />
            </div>
          </Card>

          <Card title="Alerts">
            <div className="space-y-2">
              <Alert tone="info" icon={Info}>
                Access to prod servers needs a manager's approval.
              </Alert>
              <Alert tone="success" icon={CheckCircle2}>
                Certificate issued — valid for 1 hour.
              </Alert>
              <Alert tone="warning" icon={AlertTriangle}>
                This host's key changed since it was pinned.
              </Alert>
              <Alert tone="danger" icon={XCircle}>
                Connection refused at 10.20.1.11:22.
              </Alert>
            </div>
          </Card>

          <Card
            title="Menus & modals"
            action={
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" className="gap-1.5">
                    Actions <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem>
                    <Eye className="mr-2 h-4 w-4" /> View details
                  </DropdownMenuItem>
                  <DropdownMenuItem>
                    <Pencil className="mr-2 h-4 w-4" /> Edit
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive focus:text-destructive">
                    <Trash2 className="mr-2 h-4 w-4" /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            }
          >
            <p className="text-sm text-muted-foreground">Open a form modal or a destructive confirmation.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setFormOpen(true)}>
                Open form modal
              </Button>
              <Button variant="outline" className="text-destructive" onClick={() => setConfirmOpen(true)}>
                Open confirmation
              </Button>
              <Button variant="ghost" size="sm" className="gap-1">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </div>
          </Card>
        </div>
      </div>

      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title="Add server"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setFormOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => setFormOpen(false)}>Add server</Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium">Display name</label>
            <input
              placeholder="prod-db-02"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium">Environment</label>
              <SearchableSelect value="prod" onChange={() => {}} options={ENV_OPTIONS.slice(1)} searchable={false} clearable={false} />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">IP address</label>
              <input
                placeholder="10.20.1.13"
                className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>
          <Alert tone="info" icon={Info}>
            Production servers always need approval unless your role may skip it.
          </Alert>
        </div>
      </Modal>

      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Delete 1 server?" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">prod-api-02</span> and its access history will be deleted. Active
            sessions are ended. This can't be undone.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => setConfirmOpen(false)}>
              Delete server
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/** Floating switcher: current vs new look, and light/dark. */
function LookBar({ look, setLook }) {
  const { theme, toggleTheme } = useTheme();
  const seg = (active) =>
    cn(
      'h-7 rounded-full px-3 text-xs font-medium transition-colors',
      active ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
    );
  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-center gap-1 rounded-full border border-border bg-background/85 p-1 pl-3 text-xs shadow-lg backdrop-blur">
      <Eye className="h-3.5 w-3.5 text-amber-500" />
      <span className="mr-1 font-medium text-foreground">Preview</span>
      <button type="button" className={seg(look === 'current')} onClick={() => setLook('current')}>
        Current
      </button>
      <button type="button" className={seg(look === 'new')} onClick={() => setLook('new')}>
        New look
      </button>
      <button
        type="button"
        onClick={toggleTheme}
        className="ml-1 h-7 rounded-full px-3 text-xs text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
      >
        {theme === 'dark' ? 'Light' : 'Dark'}
      </button>
      <a href="/dummy" className="h-7 rounded-full px-3 pt-1.5 text-xs text-muted-foreground hover:bg-foreground/10 hover:text-foreground">
        All previews
      </a>
    </div>
  );
}

/** /dummy/app frame: fake session, real AppLayout, theme switch. */
export function AppPreviewFrame() {
  const [params, setParams] = useSearchParams();
  const look = params.get('look') === 'current' ? 'current' : 'new';
  const setLook = (next) => setParams({ look: next }, { replace: true });

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('theme-fey', look === 'new');
    return () => root.classList.remove('theme-fey');
  }, [look]);

  return (
    <AuthContext.Provider value={SESSION}>
      <AppLayout />
      <LookBar look={look} setLook={setLook} />
    </AuthContext.Provider>
  );
}

export default PreviewContent;
