import { Server, Terminal, KeyRound, FileKey } from 'lucide-react';

const stats = [
  {
    title: 'Total Servers',
    value: '0',
    description: 'Managed infrastructure',
    icon: Server,
  },
  {
    title: 'Active Sessions',
    value: '0',
    description: 'Currently connected',
    icon: Terminal,
  },
  {
    title: 'Pending Requests',
    value: '0',
    description: 'Awaiting approval',
    icon: KeyRound,
  },
  {
    title: 'Certificates Issued',
    value: '0',
    description: 'Total issued to date',
    icon: FileKey,
  },
];

function Dashboard() {
  return (
    <div>
      <h1 className="text-lg font-semibold tracking-tight text-foreground">Dashboard</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Overview of your infrastructure and access management.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <div
              key={stat.title}
              className="rounded-lg border border-border bg-card p-5 transition-colors"
            >
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-muted-foreground">{stat.title}</p>
                <Icon className="h-4 w-4 text-muted-foreground/60" />
              </div>
              <p className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
                {stat.value}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{stat.description}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default Dashboard;
