# Task 22e — Host cache + local sessions state dir

**Phase:** 22
**Plan:** `.claude/plans/phase-22-tui-redesign.md`
**Agent:** tui
**Depends on:** task-22b

## Scope
Make the TUI feel instant with a cached host list, and support multi-window awareness via a local sessions dir.

## Steps
1. **Host cache**:
   - Persist the last successful host list fetch to `~/.shellius/cache/hosts.json` with an ETag + timestamp.
   - On startup, paint from cache immediately, then refresh in background and reconcile.
   - Respect server-side `ETag`/`If-None-Match` when possible.
   - TTL: 15 minutes (config override).
2. **Local sessions dir** `~/.shellius/sessions/`:
   - On SSH launch, write `<uuid>.json` containing `{ pid, serverId, serverName, startedAt, leaseExpiry, principal }`.
   - On SSH exit (deferred in `ExecProcess`), delete the file.
   - Historical entries kept for 7 days in `~/.shellius/sessions/history/`.
3. `/sessions` slash command reads both dirs and displays:
   - **Active** (current processes, from state dir, filtered by `pid` alive)
   - **Recent** (history, last 20)
4. "Multi-window" support: document that a second `shellius` instance sees the same cache + sessions dir and can open parallel SSH sessions to the same server under the same lease.

## Verification
- Kill network → `shellius` → host list still paints (from cache) with a "cached" badge in the footer.
- Open a session → second `shellius` instance in another terminal shows it under `/sessions`.
- Session exits → entry moves to history.
- Stale history entries older than 7 days are pruned on next launch.
