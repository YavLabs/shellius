# Task 22g — Split config and credentials storage

**Phase:** 22
**Plan:** `.claude/plans/phase-22-tui-redesign.md`
**Agent:** tui

## Scope
Migrate from the monolithic `~/.shellius/config.yaml` (which mixes prefs with tokens) to a split layout.

## Steps
1. **`~/.shellius/config.yaml`** — non-secret prefs only:
   - `serverURL`, `orgSlug`, `theme`, `keybinds`, `cacheTtl`, `logLevel`.
   - Default mode: `0644`.
2. **`~/.shellius/credentials`** — secrets only:
   - `accessToken`, `refreshToken`, `tokenExpiresAt`, `username`, `role`, `orgId`.
   - Strict mode: `0600`. Refuse to load if perms are looser.
3. Migration path:
   - On load, if the old monolithic `config.yaml` has token fields, move them to `credentials` and rewrite `config.yaml` without them. One-shot, logs what it did.
   - Keep the migration code for one release.
4. `shellius logout` removes `credentials` only, never touches `config.yaml`.
5. `shellius doctor` (from task-22a) reports both paths + perms.

## Verification
- Fresh install → both files created with correct perms.
- Existing `config.yaml` with tokens → migrated cleanly on next launch, old tokens removed from config.yaml.
- Loose perms on `credentials` (0644) → TUI refuses to load, prints a clear error.
- `shellius logout` → `credentials` gone, prefs intact.

## Out of scope
- macOS Keychain / libsecret integration. Deferred to a later phase.
