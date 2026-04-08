# Task 22q — QA gates for Phase 22 (TUI redesign)

**Phase:** 22
**Agent:** qa

## Acceptance criteria
- [ ] `shellius login` once → all future `shellius` invocations land on the active-access picker in <500ms, zero prompts.
- [ ] Typing a letter filters rows instantly.
- [ ] `↵` on a row opens SSH immediately, no intermediate forms.
- [ ] `/` opens the palette; fuzzy search works; arrow + enter runs a command; `Esc` cancels.
- [ ] `/help`, `/servers`, `/request`, `/sessions`, `/refresh`, `/logout`, `/profile`, `/quit` all work.
- [ ] `?` opens `/help` directly.
- [ ] Access token expiry → silent refresh, no visible interruption.
- [ ] Refresh token rotation → next run reads the new token successfully.
- [ ] Network down → host list paints from cache with "cached" indicator, TUI does not crash.
- [ ] `shellius doctor` prints useful diagnostics across healthy and broken states.
- [ ] Two `shellius` instances in different terminals can open parallel sessions to the same server.
- [ ] Visual inspection: single outer frame, minimal chrome, emerald accent, prod servers visibly distinct.
- [ ] `curl | sh` installer works on a fresh Linux VM.
- [ ] Config/credentials split: credentials file is `0600`, migration from old monolithic config works.
- [ ] `shellius --version` prints version + git SHA.

## Regression checks
- [ ] Existing SSH cert flow still works (cert fetched, ssh exec'd, cleaned up on exit).
- [ ] Access request submission flow still works end to end.
- [ ] No credentials leak into stdout or log files.
