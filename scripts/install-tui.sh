#!/bin/sh
# Install the Shellius TUI on macOS or Linux.
#
# This script is served by the Shellius backend itself — NOT from
# GitHub — so it works on self-hosted, private-repo deployments.
#
# One-liner:
#   curl -fsSL https://<your-shellius-host>/api/cli/install.sh | sh
#
# Or with an explicit host (useful for CI or when piping into sh
# discards the original URL):
#   SHELLIUS_HOST=https://shellius.example.com curl -fsSL \
#       "$SHELLIUS_HOST/api/cli/install.sh" | SHELLIUS_HOST="$SHELLIUS_HOST" sh
#
# What this script does:
#   1. Figures out which Shellius deployment served it (self-discovery).
#   2. Detects your OS and CPU architecture.
#   3. Downloads the matching binary from /api/cli/bin/<name>.
#   4. Verifies the SHA-256 checksum against /api/cli/bin/<name>.sha256.
#   5. Installs to /usr/local/bin/shellius (or ~/.local/bin/shellius if not writable).
#   6. Confirms with `shellius --version`.

set -e

# ---------------------------------------------------------------------------
# Colors / helpers
# ---------------------------------------------------------------------------

die()  { printf '\033[0;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[0;34m-->\033[0m %s\n' "$*"; }
ok()   { printf '\033[0;32m OK\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33mWARN:\033[0m %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------

if ! command -v curl > /dev/null 2>&1; then
    die "curl is required but was not found. Install curl and re-run this script."
fi

# ---------------------------------------------------------------------------
# Figure out which Shellius host we're installing from.
#
# Precedence:
#   1. $SHELLIUS_HOST env var (explicit override)
#   2. $0 — if the script was downloaded via curl this is set to "sh"
#      or a temp path, so it's usually useless; fall through.
#   3. Prompt the user. Only ever happens on interactive terminals.
# ---------------------------------------------------------------------------

if [ -n "$SHELLIUS_HOST" ]; then
    HOST="$SHELLIUS_HOST"
elif [ -t 0 ]; then
    printf 'Enter your Shellius URL (e.g. https://shellius.example.com): '
    read -r HOST
else
    die "SHELLIUS_HOST env var is required when piping into sh. Example:
  SHELLIUS_HOST=https://shellius.example.com curl -fsSL \"\$SHELLIUS_HOST/api/cli/install.sh\" | sh"
fi

# Strip trailing slash so URL concatenation is clean.
HOST="${HOST%/}"

# Must start with http:// or https://
case "$HOST" in
    http://*|https://*) ;;
    *) die "SHELLIUS_HOST must start with http:// or https:// (got: $HOST)" ;;
esac

info "Using Shellius host: $HOST"

# ---------------------------------------------------------------------------
# Detect OS + arch
# ---------------------------------------------------------------------------

UNAME_S="$(uname -s 2>/dev/null || echo unknown)"
UNAME_M="$(uname -m 2>/dev/null || echo unknown)"

case "$UNAME_S" in
    Darwin) OS="darwin" ;;
    Linux)  OS="linux"  ;;
    MINGW*|MSYS*|CYGWIN*)
        die "Windows is not supported by this script. Download the binary from:
  $HOST/api/cli/bin/shellius-windows-amd64.exe"
        ;;
    *)
        die "Unsupported OS: $UNAME_S"
        ;;
esac

case "$UNAME_M" in
    x86_64|amd64) ARCH="amd64" ;;
    arm64|aarch64) ARCH="arm64" ;;
    *)
        die "Unsupported architecture: $UNAME_M"
        ;;
esac

ASSET="shellius-${OS}-${ARCH}"
info "Detected platform: $OS/$ARCH → $ASSET"

# ---------------------------------------------------------------------------
# Query deployment version (best-effort — script still works if the
# endpoint is absent on older deployments)
# ---------------------------------------------------------------------------

VERSION="$(curl -fsSL "$HOST/api/cli/version" 2>/dev/null \
    | grep -o '"version":"[^"]*"' | head -n 1 | cut -d'"' -f4 || true)"
if [ -n "$VERSION" ] && [ "$VERSION" != "unknown" ]; then
    info "Deployment reports CLI version: $VERSION"
fi

# ---------------------------------------------------------------------------
# Download binary + checksum
# ---------------------------------------------------------------------------

TMPDIR="$(mktemp -d 2>/dev/null || mktemp -d -t shellius)"
trap 'rm -rf "$TMPDIR"' EXIT

BIN_URL="$HOST/api/cli/bin/$ASSET"
SUM_URL="$HOST/api/cli/bin/$ASSET.sha256"

info "Downloading: $BIN_URL"
if ! curl -fsSL "$BIN_URL" -o "$TMPDIR/$ASSET"; then
    die "Download failed. This deployment may not have published the CLI binary yet.
Ask your Shellius admin to run scripts/build-tui-binaries.sh on the server
and redeploy the backend image."
fi

info "Downloading: $SUM_URL"
if curl -fsSL "$SUM_URL" -o "$TMPDIR/$ASSET.sha256" 2>/dev/null; then
    if command -v sha256sum > /dev/null 2>&1; then
        ( cd "$TMPDIR" && sha256sum -c "$ASSET.sha256" >/dev/null 2>&1 ) \
            || die "Checksum mismatch — refusing to install."
        ok "Checksum verified"
    elif command -v shasum > /dev/null 2>&1; then
        ( cd "$TMPDIR" && shasum -a 256 -c "$ASSET.sha256" >/dev/null 2>&1 ) \
            || die "Checksum mismatch — refusing to install."
        ok "Checksum verified"
    else
        warn "No sha256sum/shasum found — skipping checksum verification."
    fi
else
    warn "Checksum file not available — proceeding without verification."
fi

chmod +x "$TMPDIR/$ASSET"

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------

TARGET_SYSTEM="/usr/local/bin/shellius"
TARGET_USER="$HOME/.local/bin/shellius"

if [ -w "/usr/local/bin" ]; then
    mv "$TMPDIR/$ASSET" "$TARGET_SYSTEM"
    INSTALLED="$TARGET_SYSTEM"
elif command -v sudo > /dev/null 2>&1; then
    info "Installing to $TARGET_SYSTEM (requires sudo)..."
    sudo install -m 0755 "$TMPDIR/$ASSET" "$TARGET_SYSTEM"
    INSTALLED="$TARGET_SYSTEM"
else
    mkdir -p "$HOME/.local/bin"
    mv "$TMPDIR/$ASSET" "$TARGET_USER"
    chmod +x "$TARGET_USER"
    INSTALLED="$TARGET_USER"
    case ":$PATH:" in
        *":$HOME/.local/bin:"*) ;;
        *)
            warn "$HOME/.local/bin is not on your PATH."
            warn "Add it with: echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc"
            ;;
    esac
fi

ok "Installed to $INSTALLED"

# ---------------------------------------------------------------------------
# Verify + next steps
# ---------------------------------------------------------------------------

if command -v shellius > /dev/null 2>&1; then
    shellius --version 2>&1 || true
fi

printf '\n'
ok "Shellius CLI is ready."
printf '\n'
printf '  Sign in:\n'
printf '    shellius login %s\n' "$HOST"
printf '\n'
printf '  Then just run:\n'
printf '    shellius\n'
printf '\n'
printf '  Useful commands:\n'
printf '    shellius doctor     Check config and connectivity\n'
printf '    shellius --logout   Clear stored credentials\n'
printf '\n'
