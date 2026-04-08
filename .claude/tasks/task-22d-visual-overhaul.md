# Task 22d — TUI visual overhaul

**Phase:** 22
**Plan:** `.claude/plans/phase-22-tui-redesign.md`
**Agent:** tui
**Depends on:** task-22b

## Scope
Rewrite `tui/internal/tui/styles.go` and sub-view rendering for a Claude-Code / Codex aesthetic: single outer border, minimal chrome, two accents max.

## Steps
1. Palette:
   - Accent (selected/active): `#10b981` (emerald, matches the web UI).
   - Warning (prod): `#ef4444`.
   - Dim helper text: muted gray.
   - Base: default foreground.
2. Single rounded outer border around the whole app. No nested borders inside sub-views.
3. Header bar: `shellius` (bold) left, `user@org · server-url` (dim) right. One line.
4. Footer bar: context-aware key hints (`↑↓ select  ↵ connect  / commands  ? help  ctrl+c quit`). One line.
5. Remove all ASCII-art separators; use lipgloss `lipgloss.Border` + thin horizontal rules.
6. Prod environment badge: red. Staging: amber. Dev/demo: green. All short labels (`PROD`, `STG`, `DEV`, `DEMO`).
7. Degrade gracefully on 256-color terminals.

## Verification
- Screenshot/manual inspection: the UI clearly reads as "terminal app in Claude-Code family" — single frame, minimal color, lots of whitespace.
- No double borders anywhere.
- Prod servers are unmissable.
- Renders correctly on a 80x24 terminal.
