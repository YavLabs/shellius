import { useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw, X } from 'lucide-react';
import { getSessionRecovery, reconnectSession } from '@/services/terminalService';

const DISCONNECTED = new Set(['lost', 'ended']);

/**
 * Workspace-level notice when terminal tabs have lost their sessions, e.g.
 * after Shellius restarted, which drops every tab at once. Each pane already
 * shows its own recovery card; this adds the bulk actions:
 *
 *   Reconnect all   reattaches or reconnects every tab whose access is still
 *                   valid, and leaves the rest (request again / re-enter a
 *                   password) on their cards
 *   Close all       closes every disconnected tab
 *
 * Shown when several tabs are affected, or when the affected one isn't on screen.
 */
function DisconnectedBanner({ workspace }) {
  const { tabs, layout, reconnectTab, closeTab, selectTab } = workspace;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const affected = tabs.filter((t) => t.kind !== 'request' && DISCONNECTED.has(t.state));
  const offscreen = affected.filter((t) => !layout.panes.includes(t.id));
  if (affected.length === 0 || (affected.length < 2 && offscreen.length === 0)) {
    return null;
  }

  const reconnectAll = async () => {
    setBusy(true);
    setResult(null);
    let ok = 0;
    const needsAttention = [];
    for (const tab of affected) {
      if (!tab.sessionId) {
        needsAttention.push(tab);
        continue;
      }
      try {
        const info = await getSessionRecovery(tab.sessionId);
        if (info.action === 'attach') {
          reconnectTab(tab.id, { attach: tab.sessionId });
          ok += 1;
        } else if (info.action === 'reconnect') {
          reconnectTab(tab.id, await reconnectSession(tab.sessionId));
          ok += 1;
        } else {
          needsAttention.push(tab);
        }
      } catch {
        needsAttention.push(tab);
      }
    }
    setBusy(false);
    setResult({ ok, needsAttention: needsAttention.map((t) => t.id) });
  };

  const closeAll = () => {
    affected.forEach((t) => closeTab(t.id));
    setResult(null);
  };

  const attentionTabs = (result?.needsAttention || []).filter((id) => affected.some((t) => t.id === id));

  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-amber-500/25 bg-amber-500/[0.08] py-1 pl-3 pr-1 text-[13px]"
    >
      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
      <span className="text-foreground">
        {affected.length === 1
          ? '1 terminal lost its session.'
          : `${affected.length} terminals lost their sessions.`}
        {result && (
          <span className="text-muted-foreground">
            {' '}
            Reconnected {result.ok}.
            {attentionTabs.length > 0 && ` ${attentionTabs.length} need${attentionTabs.length === 1 ? 's' : ''} you to request access or sign in again.`}
          </span>
        )}
      </span>
      <div className="ml-auto flex items-center gap-1">
        {attentionTabs.length > 0 ? (
          <button
            type="button"
            onClick={() => selectTab(attentionTabs[0])}
            className="inline-flex h-7 items-center rounded-md px-2.5 font-medium text-foreground transition-colors hover:bg-foreground/[0.07]"
          >
            Show
          </button>
        ) : (
          offscreen.length > 0 && (
            <button
              type="button"
              onClick={() => selectTab(offscreen[0].id)}
              className="inline-flex h-7 items-center rounded-md px-2.5 font-medium text-foreground transition-colors hover:bg-foreground/[0.07]"
            >
              Show
            </button>
          )
        )}
        <button
          type="button"
          onClick={reconnectAll}
          disabled={busy}
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 font-medium text-foreground transition-colors hover:bg-foreground/[0.07] disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Reconnect all
        </button>
        <button
          type="button"
          onClick={closeAll}
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.07] hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" /> Close all
        </button>
      </div>
    </div>
  );
}

export default DisconnectedBanner;
