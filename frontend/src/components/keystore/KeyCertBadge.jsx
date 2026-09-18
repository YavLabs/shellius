import { ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';

/**
 * KeyCertBadge — small "Cert" indicator for an SshKeyDTO that has a
 * `certificate` summary ({ type, keyId, principals, validAfter, validBefore,
 * expired, caFingerprint }). Renders nothing when the key has no certificate.
 */
function KeyCertBadge({ certificate }) {
  if (!certificate) return null;
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className={
              certificate.expired
                ? 'gap-1 border-destructive/40 text-destructive'
                : 'gap-1 border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
            }
          >
            <ShieldCheck className="h-3 w-3" /> Cert
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs">
          <p className="font-medium">{certificate.keyId || 'Unnamed certificate'}</p>
          {certificate.principals?.length > 0 && (
            <p className="mt-0.5 text-muted-foreground">
              Principals: {certificate.principals.join(', ')}
            </p>
          )}
          <p className="mt-0.5 text-muted-foreground">
            Valid until{' '}
            {certificate.validBefore ? new Date(certificate.validBefore).toLocaleString() : 'unknown'}
          </p>
          {certificate.expired && <p className="mt-0.5 font-medium text-destructive">Expired</p>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export default KeyCertBadge;
