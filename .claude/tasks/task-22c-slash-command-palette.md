# Task 22c — Slash-command palette

**Phase:** 22
**Plan:** `.claude/plans/phase-22-tui-redesign.md`
**Agent:** tui
**Depends on:** task-22b

## Scope
Add a Claude-Code-style slash-command palette triggered by `/` with fuzzy search and a pluggable command registry.

## Steps
1. New model `paletteModel` in `tui/internal/tui/palette.go`:
   - Triggered when the user types `/` at the input in any view.
   - Renders a dropdown overlay with the current filter + matching commands.
   - Fuzzy filter via a simple ranked substring match.
2. Command registry:
   ```go
   type Command struct {
     Name, Desc string
     Run        func(app *AppModel) tea.Cmd
   }
   ```
3. Register built-ins:
   - `/help` — cheatsheet overlay
   - `/servers` — open the full host list (old default view)
   - `/request <server>` — open the AccessRequest form
   - `/sessions` — show recent sessions (task-22e)
   - `/refresh` — force host list + active-access refetch
   - `/logout` — clear tokens and exit
   - `/profile` — identity, token expiry, server URL overlay
   - `/quit` — exit
4. `?` key shortcut opens `/help` directly.
5. `Esc` closes the palette without running a command.

## Verification
- `/` opens palette; typing filters; `↑↓` navigates; `↵` runs; `Esc` cancels.
- All built-in commands work.
- Palette renders correctly at all terminal widths (min 80 cols).
