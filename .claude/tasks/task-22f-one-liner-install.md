# Task 22f — One-liner install script + release pipeline

**Phase:** 22
**Plan:** `.claude/plans/phase-22-tui-redesign.md`
**Agent:** devops

## Scope
Ship a `curl | sh` installer and GitHub Actions release workflow so any developer can install the TUI on their laptop in one line.

## Steps
1. **`scripts/install-tui.sh`** (hosted later at `https://get.shellius.io/tui` or similar):
   - Detects OS (darwin/linux/windows) and arch (amd64/arm64) from `uname`.
   - Fetches the matching binary from the GitHub Releases `latest` tag.
   - Verifies checksum.
   - Installs to `/usr/local/bin/shellius` if writable, else `~/.local/bin/shellius`.
   - `chmod +x`.
   - Prints next steps: `shellius login <your-server-url>`.
2. **GitHub Actions workflow** `.github/workflows/release-tui.yml`:
   - Triggers on `v*` tags.
   - Cross-compiles the matrix via the existing `tui/Makefile` `build-all` target.
   - Generates checksums.
   - Creates a GitHub Release with the binaries + `install-tui.sh`.
3. **`shellius --version`** prints build timestamp + git SHA + version (wire through the Makefile `-X main.version=` flag).

## Verification
- `curl -fsSL https://get.shellius.io/tui | sh` on a fresh Linux box → binary installed and runnable.
- `shellius --version` prints the expected version.
- Release workflow succeeds on a test tag in a fork.
