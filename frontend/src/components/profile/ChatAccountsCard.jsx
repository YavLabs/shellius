import { useCallback, useEffect, useState } from 'react';
import { MessageSquare, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/settings/shared';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import { listMyChatIdentities, unlinkChatIdentity } from '@/services/chatIdentityService';
import { platformLabel, platformIcon } from './chatIdentityHelpers';
import { formatDateTime, relativeTime } from '@/utils/time';

function IdentityRow({ identity, onUnlink, busy }) {
  const label = platformLabel(identity.platform);
  const Icon = platformIcon(identity.platform) || MessageSquare;
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border p-3">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground/[0.05]">
          <Icon className="h-4 w-4 text-foreground/70" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">Linked {formatDateTime(identity.linkedAt)}</p>
          <p className="text-xs text-muted-foreground">
            {identity.lastUsedAt ? `Last used ${relativeTime(identity.lastUsedAt)}` : 'Never used'}
          </p>
        </div>
      </div>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="shrink-0 text-destructive hover:text-destructive"
        onClick={() => onUnlink(identity)}
        disabled={busy}
      >
        <Trash2 className="mr-1.5 h-3.5 w-3.5" />
        Unlink
      </Button>
    </div>
  );
}

/**
 * ChatAccountsCard — the signed-in user's own linked chat accounts
 * (GET/DELETE /api/chat/identities). Linking itself never happens here: it
 * starts with an approve/deny button press in chat and finishes at
 * /chat/link (pages/ChatLink.jsx) — this card only shows what is already
 * bound, and lets the person remove it.
 */
export default function ChatAccountsCard() {
  const [identities, setIdentities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [confirmTarget, setConfirmTarget] = useState(null);

  const refresh = useCallback(() => {
    setLoading(true);
    return listMyChatIdentities()
      .then((list) => {
        setIdentities(list || []);
        setError('');
      })
      .catch((err) => setError(err.response?.data?.error?.message || err.message || 'Failed to load chat accounts.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleUnlinkConfirmed = async () => {
    const target = confirmTarget;
    setConfirmTarget(null);
    if (!target) return;
    setBusyId(target.id);
    try {
      await unlinkChatIdentity(target.id);
      setIdentities((prev) => prev.filter((i) => i.id !== target.id));
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to unlink account.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <SectionCard
      title="Chat accounts"
      description="Chat accounts linked to approve and deny access requests from Slack and other platforms."
    >
      {error && (
        <div className="mb-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {[1, 2].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : identities.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-8 text-center">
          <MessageSquare className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">
            No chat accounts linked yet — press approve or deny on a request in Slack to start linking one.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {identities.map((identity) => (
            <IdentityRow
              key={identity.id}
              identity={identity}
              busy={busyId === identity.id}
              onUnlink={(target) => setConfirmTarget(target)}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!confirmTarget}
        title={`Unlink ${platformLabel(confirmTarget?.platform)}?`}
        message="You will no longer be able to approve or deny access requests from this account until you link it again."
        confirmLabel="Unlink"
        variant="destructive"
        onConfirm={handleUnlinkConfirmed}
        onCancel={() => setConfirmTarget(null)}
      />
    </SectionCard>
  );
}
