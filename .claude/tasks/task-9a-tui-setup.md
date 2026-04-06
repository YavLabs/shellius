# Task 9A: TUI Client Setup

**Agent:** tui
**Status:** [ ] Pending
**Blocks:** 9B
**Blocked By:** None

## Objective
Initialize the Go module for the Shellius TUI client with all dependencies, build system, and configuration package.

## Deliverables
- `tui/go.mod` — Go module init (`github.com/shellius/tui` or similar)
- `tui/go.sum` — dependency lock file
- Dependencies:
  - `github.com/charmbracelet/bubbletea` — TUI framework
  - `github.com/charmbracelet/lipgloss` — styling
  - `github.com/charmbracelet/bubbles` — UI components (textinput, list, spinner, table, viewport)
  - `github.com/zalando/go-keyring` — secure token storage
  - `github.com/spf13/viper` — configuration
- `tui/Makefile`:
  - `build` — compile for current platform
  - `build-all` — cross-compile for linux/amd64, linux/arm64, darwin/amd64, darwin/arm64
  - `install` — build and copy to $GOPATH/bin
  - `clean` — remove build artifacts
  - `lint` — run golangci-lint
- `tui/internal/config/config.go`:
  - Load config from `~/.config/shellius/config.yaml`
  - Config struct: ServerURL, DefaultPrincipal, Theme (dark/light), KeyDir
  - Defaults and validation
  - First-run setup (prompt for server URL)

## Acceptance Criteria
- `go build ./...` succeeds with no errors
- `make build` produces a working binary
- `make build-all` produces binaries for all target platforms
- Config package loads and saves configuration correctly
- Default config is created on first run if none exists
- Config file path respects XDG_CONFIG_HOME if set
