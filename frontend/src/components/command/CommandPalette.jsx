import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Server,
  Building2,
  Users as UsersIcon,
  UserPlus,
  KeySquare,
  Shield,
  Terminal,
  Copy,
  Check,
  Loader2,
  ArrowRight,
  CornerDownLeft,
  Send,
  KeyRound,
} from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import { Badge } from '@/components/ui/badge';
import { roleTone, protocolTone } from '@/lib/badgeTones';
import Avatar from '@/components/ui/Avatar';
import ConnectModal from '@/components/servers/ConnectModal';
import RequestForm from '@/components/access-requests/RequestForm';
import { useAuth } from '@/context/AuthContext';
import { useCommandPalette } from '@/context/CommandPaletteContext';
import { useQuickConnect } from '@/context/QuickConnectContext';
import { can } from '@/lib/permissions';
import { QUICK_ACTIONS, NAV_ITEMS, isQuickActionVisible, isNavItemVisible, matchesQuery, matchesNavItem } from '@/lib/commands';
import { globalSearch } from '@/services/searchService';
import { getAccessIntent } from '@/services/accessRequestService';
import { getRecentPaletteResults, addRecentPaletteResult } from '@/lib/paletteRecent';
import { runQuickAction as runQuickActionShared } from '@/lib/runQuickAction';

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPod|iPad/i.test(navigator.platform || navigator.userAgent || '');
const MOD_LABEL = isMac ? '⌘' : 'Ctrl';

const GROUP_META = {
  servers: { label: 'Servers', icon: Server },
  customers: { label: 'Customers', icon: Building2 },
  users: { label: 'Users', icon: UsersIcon },
  identities: { label: 'Identities', icon: UserPlus },
  keys: { label: 'SSH Keys', icon: KeySquare },
  policies: { label: 'Policies', icon: Shield },
};
const RESULT_ORDER = ['servers', 'customers', 'users', 'identities', 'keys', 'policies'];

function HighlightedText({ text, query }) {
  if (!query || !text) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-sm bg-primary/20 text-inherit">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

function Kbd({ children }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 font-mono text-[10px] font-medium text-muted-foreground">
      {children}
    </kbd>
  );
}

/**
 * CommandPalette — Linear/Vercel-style ⌘K palette. Mounted once in
 * AppLayout; visibility controlled by CommandPaletteContext.
 *
 * Empty query: Quick actions / Navigation / Recent.
 * Query >= 2 chars: debounced GET /api/search plus locally filtered actions
 * and navigation.
 */
function CommandPalette() {
  const { open, setOpen, closePalette } = useCommandPalette();
  const { allowed: quickConnectAllowed, openQuickConnect } = useQuickConnect();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [recents, setRecents] = useState([]);
  const [highlighted, setHighlighted] = useState('');
  const [serverIntents, setServerIntents] = useState({});
  const [copiedKey, setCopiedKey] = useState('');
  const [connectTarget, setConnectTarget] = useState(null); // { server, intent }
  const [requestTarget, setRequestTarget] = useState(null); // server

  const abortRef = useRef(null);
  const copyTimerRef = useRef(null);

  const canDeployKeys = can(user, 'keystore.deploy');

  // ⌘K / Ctrl+K opens from anywhere, even while typing in another input.
  useEffect(() => {
    function handleKeyDown(e) {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setOpen]);

  // "/" opens the palette when not already open and not typing elsewhere.
  useEffect(() => {
    if (open) return undefined;
    function handleKeyDown(e) {
      if (e.key !== '/') return;
      const tag = document.activeElement?.tagName?.toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || document.activeElement?.isContentEditable;
      if (typing) return;
      e.preventDefault();
      setOpen(true);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, setOpen]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setDebounced('');
      setResults(null);
      setSearchError('');
      setServerIntents({});
      setRecents(getRecentPaletteResults());
    }
  }, [open]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 150);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    if (debounced.length < 2) {
      setResults(null);
      setLoading(false);
      setSearchError('');
      return undefined;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setSearchError('');
    globalSearch(debounced, { limit: 5, signal: controller.signal })
      .then((data) => setResults(data?.results || null))
      .catch((err) => {
        if (err.code === 'ERR_CANCELED' || err.name === 'CanceledError' || err.name === 'AbortError') return;
        setSearchError(err.response?.data?.error?.message || err.message || 'Search failed');
        setResults(null);
      })
      .finally(() => {
        if (abortRef.current === controller) setLoading(false);
      });
    return () => controller.abort();
  }, [debounced]);

  const showResultsMode = query.trim().length >= 2;

  const visibleQuickActions = useMemo(
    () =>
      QUICK_ACTIONS.filter((a) => a.id !== 'command-palette' && isQuickActionVisible(a, user, quickConnectAllowed)).filter(
        (a) => matchesQuery(a.label, showResultsMode ? query : '')
      ),
    [user, quickConnectAllowed, query, showResultsMode]
  );

  const visibleNavItems = useMemo(
    () => NAV_ITEMS.filter((n) => isNavItemVisible(n, user)).filter((n) => matchesNavItem(n, showResultsMode ? query : '')),
    [user, query, showResultsMode]
  );

  // Prefetch access intent for the highlighted server result so the inline
  // "Connect" / "Request access" secondary action can render immediately.
  useEffect(() => {
    const m = /^result:servers:(.+)$/.exec(highlighted);
    if (!m) return;
    const id = m[1];
    if (serverIntents[id] !== undefined) return;
    getAccessIntent(id)
      .then((data) => setServerIntents((prev) => ({ ...prev, [id]: data })))
      .catch(() => setServerIntents((prev) => ({ ...prev, [id]: null })));
  }, [highlighted, serverIntents]);

  const closeAll = useCallback(() => {
    closePalette();
  }, [closePalette]);

  const goTo = useCallback(
    (href, recentEntry) => {
      if (recentEntry) addRecentPaletteResult(recentEntry);
      closeAll();
      navigate(href);
    },
    [closeAll, navigate]
  );

  const copyText = useCallback((text, key) => {
    if (!text) return;
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopiedKey(key);
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => setCopiedKey(''), 1500);
      })
      .catch(() => {});
  }, []);

  const runQuickAction = useCallback(
    (action) =>
      runQuickActionShared(action, {
        navigate,
        openQuickConnect,
        onBeforeRun: closeAll,
      }),
    [closeAll, navigate, openQuickConnect]
  );

  // --- Result actions ----------------------------------------------------

  const openResult = useCallback(
    (type, item) => {
      goTo(item.href, { id: item.id, type, title: item.title, subtitle: item.subtitle, href: item.href });
    },
    [goTo]
  );

  const secondaryActionsFor = useCallback(
    (type, item) => {
      if (type === 'servers') {
        const intent = serverIntents[item.id];
        const actions = [];
        if (intent?.hasActiveAccess) {
          actions.push({
            id: 'connect',
            label: 'Connect',
            icon: Terminal,
            run: () => {
              closeAll();
              setConnectTarget({ server: { id: item.id, ...item.meta, hostname: item.meta?.hostname || item.title }, intent });
            },
          });
        } else if (intent !== undefined) {
          actions.push({
            id: 'request-access',
            label: 'Request access',
            icon: KeyRound,
            run: () => {
              closeAll();
              setRequestTarget(item.id);
            },
          });
        }
        if (item.meta?.ipAddress) {
          actions.push({
            id: 'copy-ip',
            label: copiedKey === `${item.id}:copy-ip` ? 'Copied' : 'Copy IP',
            icon: copiedKey === `${item.id}:copy-ip` ? Check : Copy,
            run: () => copyText(item.meta.ipAddress, `${item.id}:copy-ip`),
            keepOpen: true,
          });
        }
        if (canDeployKeys) {
          actions.push({
            id: 'deploy-key',
            label: 'Export key to servers',
            icon: Send,
            run: () => goTo(`/keystore?tab=deployments&action=deploy&serverId=${item.id}`),
          });
        }
        return actions;
      }
      if (type === 'users') {
        return item.meta?.email
          ? [
              {
                id: 'copy-email',
                label: copiedKey === `${item.id}:copy-email` ? 'Copied' : 'Copy email',
                icon: copiedKey === `${item.id}:copy-email` ? Check : Copy,
                run: () => copyText(item.meta.email, `${item.id}:copy-email`),
                keepOpen: true,
              },
            ]
          : [];
      }
      if (type === 'keys') {
        return item.meta?.fingerprint
          ? [
              {
                id: 'copy-fingerprint',
                label: copiedKey === `${item.id}:copy-fp` ? 'Copied' : 'Copy fingerprint',
                icon: copiedKey === `${item.id}:copy-fp` ? Check : Copy,
                run: () => copyText(item.meta.fingerprint, `${item.id}:copy-fp`),
                keepOpen: true,
              },
            ]
          : [];
      }
      if (type === 'customers') {
        return [
          {
            id: 'new-server',
            label: 'New server for customer',
            icon: Server,
            run: () => goTo(`/servers?action=new&customerId=${item.id}`),
          },
        ];
      }
      return [];
    },
    [serverIntents, copiedKey, copyText, canDeployKeys, goTo, closeAll]
  );

  // Cmd/Ctrl+Enter runs the highlighted item's first secondary action.
  const handleListKeyDown = useCallback(
    (e) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (e.key !== 'Enter' || !mod) return;
      const m = /^result:([a-z]+):(.+)$/.exec(highlighted);
      if (!m) return;
      const [, type, id] = m;
      const list = results?.[type] || [];
      const item = list.find((r) => r.id === id);
      if (!item) return;
      const actions = secondaryActionsFor(type, item);
      if (actions[0]) {
        e.preventDefault();
        e.stopPropagation();
        actions[0].run();
      }
    },
    [highlighted, results, secondaryActionsFor]
  );

  const noStaticMatches = visibleQuickActions.length === 0 && visibleNavItems.length === 0;
  const noSearchResults =
    !results || RESULT_ORDER.every((k) => !(results[k] || []).length);
  const showEmptyState = showResultsMode && !loading && noStaticMatches && noSearchResults && !searchError;

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl p-0" showClose={false} aria-describedby="command-palette-description">
          <DialogTitle className="sr-only">Command palette</DialogTitle>
          <DialogDescription id="command-palette-description" className="sr-only">
            Search servers, customers, users, identities, keys and policies, or run a quick action.
          </DialogDescription>
          <Command shouldFilter={false} value={highlighted} onValueChange={setHighlighted} loop>
            <CommandInput
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder="Search servers, customers, users, keys, policies..."
            />
            <div onKeyDownCapture={handleListKeyDown}>
              <CommandList>
                {showEmptyState && <CommandEmpty>No results for &ldquo;{query}&rdquo;</CommandEmpty>}
                {searchError && (
                  <div className="px-3 py-2 text-sm text-destructive">{searchError}</div>
                )}
                {loading && showResultsMode && (
                  <div className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching...
                  </div>
                )}

                {!showResultsMode && recents.length > 0 && (
                  <CommandGroup heading="Recent">
                    {recents.map((r) => (
                      <CommandItem
                        key={`recent:${r.type}:${r.id}`}
                        value={`recent:${r.type}:${r.id}`}
                        onSelect={() => goTo(r.href)}
                      >
                        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{r.title}</span>
                        {r.subtitle && <span className="truncate text-xs text-muted-foreground">{r.subtitle}</span>}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}

                {visibleQuickActions.length > 0 && (
                  <CommandGroup heading="Quick actions">
                    {visibleQuickActions.map((a) => {
                      const Icon = a.icon;
                      return (
                        <CommandItem key={`action:${a.id}`} value={`action:${a.id}`} onSelect={() => runQuickAction(a)}>
                          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="flex-1 truncate">
                            <HighlightedText text={a.label} query={showResultsMode ? query : ''} />
                          </span>
                          {a.shortcutHint && <CommandShortcut>{a.shortcutHint}</CommandShortcut>}
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                )}

                {visibleNavItems.length > 0 && (
                  <CommandGroup heading="Navigation">
                    {visibleNavItems.map((n) => {
                      const Icon = n.icon;
                      return (
                        <CommandItem key={`nav:${n.id}`} value={`nav:${n.id}`} onSelect={() => goTo(n.to)}>
                          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="flex-1 truncate">
                            <HighlightedText text={n.label} query={showResultsMode ? query : ''} />
                          </span>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                )}

                {showResultsMode &&
                  RESULT_ORDER.map((type) => {
                    const items = results?.[type] || [];
                    if (items.length === 0) return null;
                    const { label, icon: GroupIcon } = GROUP_META[type];
                    return (
                      <CommandGroup key={type} heading={label}>
                        {items.map((item) => {
                          const key = `result:${type}:${item.id}`;
                          const isHighlighted = highlighted === key;
                          const actions = isHighlighted ? secondaryActionsFor(type, item) : [];
                          return (
                            <CommandItem key={key} value={key} onSelect={() => openResult(type, item)}>
                              {type === 'users' ? (
                                <Avatar name={item.title} email={item.subtitle} avatarUrl={item.meta?.avatarUrl} size="xs" />
                              ) : (
                                <GroupIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              )}
                              <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-1.5 truncate text-sm">
                                  <HighlightedText text={item.title} query={query} />
                                  {type === 'servers' && item.meta?.environment && (
                                    <EnvironmentBadge environment={item.meta.environment} />
                                  )}
                                  {type === 'servers' && item.meta?.protocol && (
                                    <Badge tone={protocolTone(item.meta.protocol).tone}>
                                      {protocolTone(item.meta.protocol).label}
                                    </Badge>
                                  )}
                                  {type === 'users' && item.meta?.role && (
                                    <Badge tone={roleTone(item.meta.role).tone}>
                                      {roleTone(item.meta.role).label}
                                    </Badge>
                                  )}
                                  {type === 'keys' && item.meta?.fingerprint && (
                                    <span className="truncate font-mono text-[10px] text-muted-foreground">
                                      {item.meta.fingerprint}
                                    </span>
                                  )}
                                </span>
                                {item.subtitle && (
                                  <span className="block truncate text-xs text-muted-foreground">
                                    <HighlightedText text={item.subtitle} query={query} />
                                  </span>
                                )}
                              </span>

                              {isHighlighted && actions.length > 0 && (
                                <span className="flex shrink-0 items-center gap-1 pl-2">
                                  {actions.map((act) => {
                                    const ActIcon = act.icon;
                                    return (
                                      <button
                                        key={act.id}
                                        type="button"
                                        onMouseDown={(e) => e.stopPropagation()}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          act.run();
                                        }}
                                        className="inline-flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                                      >
                                        {ActIcon && <ActIcon className="h-3 w-3" />}
                                        {act.label}
                                      </button>
                                    );
                                  })}
                                </span>
                              )}
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    );
                  })}
              </CommandList>
            </div>
          </Command>

          <div className="flex items-center justify-between border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-3">
              <span className="flex items-center gap-1">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> navigate
              </span>
              <span className="flex items-center gap-1">
                <Kbd><CornerDownLeft className="h-2.5 w-2.5" /></Kbd> select
              </span>
              <span className="hidden items-center gap-1 sm:flex">
                <Kbd>{MOD_LABEL}</Kbd>
                <Kbd><CornerDownLeft className="h-2.5 w-2.5" /></Kbd> secondary
              </span>
            </span>
            <span className="flex items-center gap-1">
              <Kbd>esc</Kbd> close
            </span>
          </div>
        </DialogContent>
      </Dialog>

      {connectTarget && (
        <ConnectModal
          open={!!connectTarget}
          onClose={() => setConnectTarget(null)}
          server={connectTarget.server}
          intent={connectTarget.intent}
          currentUser={user}
        />
      )}

      {requestTarget && (
        <RequestForm
          open={!!requestTarget}
          onClose={() => setRequestTarget(null)}
          onSuccess={() => setRequestTarget(null)}
          initialServerId={requestTarget}
        />
      )}
    </>
  );
}

export default CommandPalette;
