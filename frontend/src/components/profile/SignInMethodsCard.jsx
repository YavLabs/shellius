import { KeyRound, Lock, CheckCircle2 } from 'lucide-react';

function SectionCard({ title, description, children }) {
  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="mb-5">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  );
}

function Row({ icon: Icon, label, active, detail }) {
  return (
    <div className="flex items-center justify-between border-b border-border py-3 last:border-0">
      <div className="flex items-center gap-3">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <div>
          <p className="text-sm font-medium text-foreground">{label}</p>
          {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
        </div>
      </div>
      {active ? (
        <span className="flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5" /> Active
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">Not set up</span>
      )}
    </div>
  );
}

/**
 * SignInMethodsCard — read-only summary of how this account can sign in:
 * password and/or a linked SSO provider, from the /auth/me DTO.
 */
export default function SignInMethodsCard({ hasPassword, ssoProvider }) {
  return (
    <SectionCard title="Sign-in methods" description="How you can sign in to your account.">
      <div className="divide-y divide-border">
        <Row icon={Lock} label="Password" active={!!hasPassword} />
        <Row
          icon={KeyRound}
          label="Single sign-on"
          active={!!ssoProvider}
          detail={ssoProvider ? `Linked via ${ssoProvider}` : undefined}
        />
      </div>
    </SectionCard>
  );
}
