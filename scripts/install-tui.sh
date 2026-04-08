#!/bin/sh
# Install the Shellius TUI on macOS or Linux.
#
# One-liner:
#   curl -fsSL https://raw.githubusercontent.com/vaidyayash8/shellius/main/scripts/install-tui.sh | sh
#
# What this script does:
#   1. Detects your OS and CPU architecture.
#   2. Fetches the latest release metadata from GitHub.
#   3. Downloads the matching binary and its SHA-256 checksum file.
#   4. Verifies the checksum.
#   5. Installs to /usr/local/bin/shellius (or ~/.local/bin/shellius if not writable).
#   6. Confirms the installation with `shellius --version`.

set -e

REPO="vaidyayash8/shellius"
RELEASES_API="https://api.github.com/repos/${REPO}/releases/latest"
UA="shellius-install/1.0 (https://github.com/${REPO})"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

die() {
    printf '\033[0;31mERROR:\033[0m %s\n' "$*" >&2
    exit 1
}

info() {
    printf '\033[0;34m-->\033[0m %s\n' "$*"
}

ok() {
    printf '\033[0;32m OK\033[0m %s\n' "$*"
}

warn() {
    printf '\033[0;33mWARN:\033[0m %s\n' "$*" >&2
}

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------

if ! command -v curl > /dev/null 2>&1; then
    die "curl is required but was not found. Install curl and re-run this script."
fi

# ---------------------------------------------------------------------------
# Detect OS
# ---------------------------------------------------------------------------

RAW_OS="$(uname -s)"
case "${RAW_OS}" in
    Darwin)  OS="darwin" ;;
    Linux)   OS="linux" ;;
    MINGW*|MSYS*|CYGWIN*|Windows*)
        die "Windows is not supported by this installer. Download the .exe binary directly from:
  https://github.com/${REPO}/releases/latest"
        ;;
    *)
        die "Unsupported operating system: ${RAW_OS}. Only linux and darwin are supported."
        ;;
esac

# ---------------------------------------------------------------------------
# Detect architecture
# ---------------------------------------------------------------------------

RAW_ARCH="$(uname -m)"
case "${RAW_ARCH}" in
    x86_64|amd64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *)
        die "Unsupported CPU architecture: ${RAW_ARCH}. Only amd64 and arm64 are supported."
        ;;
esac

info "Detected platform: ${OS}/${ARCH}"

# ---------------------------------------------------------------------------
# Fetch latest release metadata
# ---------------------------------------------------------------------------

info "Fetching latest release from GitHub..."

RELEASE_JSON="$(curl -fsSL \
    -H "Accept: application/vnd.github+json" \
    -A "${UA}" \
    "${RELEASES_API}" 2>&1)" || die "Failed to fetch release metadata from ${RELEASES_API}.
Check your internet connection or visit https://github.com/${REPO}/releases manually."

# Extract tag_name (POSIX sed, no perl/python required)
TAG="$(printf '%s' "${RELEASE_JSON}" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"

if [ -z "${TAG}" ]; then
    die "Could not parse release tag from GitHub API response. The response was:
${RELEASE_JSON}"
fi

info "Latest release: ${TAG}"

# Strip leading "tui/" prefix if present (tags are tui/v0.2.0 → v0.2.0)
VERSION="${TAG#tui/}"

# ---------------------------------------------------------------------------
# Resolve asset names
# ---------------------------------------------------------------------------

BINARY_ASSET="shellius-${OS}-${ARCH}"
CHECKSUM_ASSET="${BINARY_ASSET}.sha256"

# ---------------------------------------------------------------------------
# Extract download URLs from the release JSON
# ---------------------------------------------------------------------------

# We look for browser_download_url entries that match the asset name exactly.
# The JSON has pairs: "name": "...", then "browser_download_url": "..."
# We use a two-pass approach: find the name, grab the next download_url line.

extract_url() {
    # $1 = asset filename to look for
    printf '%s' "${RELEASE_JSON}" | grep -A 5 "\"name\": \"${1}\"" | grep '"browser_download_url"' | head -1 | sed 's/.*"browser_download_url": *"\([^"]*\)".*/\1/'
}

BINARY_URL="$(extract_url "${BINARY_ASSET}")"
CHECKSUM_URL="$(extract_url "${CHECKSUM_ASSET}")"

if [ -z "${BINARY_URL}" ]; then
    die "No release asset found for '${BINARY_ASSET}' in release ${TAG}.
Visit https://github.com/${REPO}/releases/tag/${TAG} to see available assets."
fi

if [ -z "${CHECKSUM_URL}" ]; then
    die "No checksum asset found for '${CHECKSUM_ASSET}' in release ${TAG}.
The release may be incomplete."
fi

# ---------------------------------------------------------------------------
# Download to temp directory
# ---------------------------------------------------------------------------

TMPDIR="$(mktemp -d 2>/dev/null || mktemp -d -t shellius-install)"
BINARY_TMP="${TMPDIR}/${BINARY_ASSET}"
CHECKSUM_TMP="${TMPDIR}/${CHECKSUM_ASSET}"

# Ensure cleanup on exit
trap 'rm -rf "${TMPDIR}"' EXIT INT TERM

info "Downloading ${BINARY_ASSET}..."
curl -fsSL -A "${UA}" -o "${BINARY_TMP}" "${BINARY_URL}" || \
    die "Failed to download binary from ${BINARY_URL}"

info "Downloading ${CHECKSUM_ASSET}..."
curl -fsSL -A "${UA}" -o "${CHECKSUM_TMP}" "${CHECKSUM_URL}" || \
    die "Failed to download checksum from ${CHECKSUM_URL}"

# ---------------------------------------------------------------------------
# Verify checksum
# ---------------------------------------------------------------------------

info "Verifying checksum..."

# The .sha256 file may contain "HASH  filename" or just "HASH"
EXPECTED_HASH="$(awk '{print $1}' "${CHECKSUM_TMP}")"

if command -v sha256sum > /dev/null 2>&1; then
    ACTUAL_HASH="$(sha256sum "${BINARY_TMP}" | awk '{print $1}')"
elif command -v shasum > /dev/null 2>&1; then
    ACTUAL_HASH="$(shasum -a 256 "${BINARY_TMP}" | awk '{print $1}')"
else
    warn "Neither sha256sum nor shasum found — skipping checksum verification."
    ACTUAL_HASH="${EXPECTED_HASH}"
fi

if [ "${ACTUAL_HASH}" != "${EXPECTED_HASH}" ]; then
    die "Checksum mismatch for ${BINARY_ASSET}!
  Expected : ${EXPECTED_HASH}
  Got      : ${ACTUAL_HASH}
The download may be corrupted or tampered with. Aborting."
fi

ok "Checksum verified."

# ---------------------------------------------------------------------------
# Determine install location
# ---------------------------------------------------------------------------

INSTALL_DIR="/usr/local/bin"
NEEDS_SUDO=0

if [ ! -d "${INSTALL_DIR}" ]; then
    mkdir -p "${INSTALL_DIR}" 2>/dev/null || NEEDS_SUDO=1
fi

if [ ! -w "${INSTALL_DIR}" ]; then
    NEEDS_SUDO=1
fi

if [ "${NEEDS_SUDO}" = "1" ]; then
    # Fall back to ~/.local/bin if sudo is unavailable
    if ! command -v sudo > /dev/null 2>&1; then
        INSTALL_DIR="${HOME}/.local/bin"
        warn "sudo not available and /usr/local/bin is not writable."
        warn "Installing to ${INSTALL_DIR} instead."
    else
        info "${INSTALL_DIR} requires elevated permissions — will use sudo."
    fi
fi

DEST="${INSTALL_DIR}/shellius"

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------

info "Installing shellius ${VERSION} to ${DEST}..."

chmod +x "${BINARY_TMP}"

if [ "${NEEDS_SUDO}" = "1" ] && [ "${INSTALL_DIR}" = "/usr/local/bin" ]; then
    sudo mkdir -p "${INSTALL_DIR}" || die "sudo mkdir -p ${INSTALL_DIR} failed."
    sudo mv "${BINARY_TMP}" "${DEST}" || die "Failed to install binary to ${DEST} (sudo mv failed)."
    sudo chmod +x "${DEST}" || die "Failed to chmod +x ${DEST}."
else
    mkdir -p "${INSTALL_DIR}" || die "Failed to create install directory ${INSTALL_DIR}."
    mv "${BINARY_TMP}" "${DEST}" || die "Failed to install binary to ${DEST}."
    chmod +x "${DEST}"
fi

ok "Installed to ${DEST}"

# ---------------------------------------------------------------------------
# PATH warning for non-standard install dir
# ---------------------------------------------------------------------------

if [ "${INSTALL_DIR}" != "/usr/local/bin" ]; then
    case ":${PATH}:" in
        *":${INSTALL_DIR}:"*) ;;
        *)
            warn "${INSTALL_DIR} is not in your PATH."
            warn "Add the following line to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
            warn "  export PATH=\"${INSTALL_DIR}:\$PATH\""
            warn "Then reload your shell or run: source ~/.bashrc"
            ;;
    esac
fi

# ---------------------------------------------------------------------------
# Smoke test
# ---------------------------------------------------------------------------

info "Verifying installation..."

if "${DEST}" --version > /dev/null 2>&1; then
    INSTALLED_VERSION="$("${DEST}" --version 2>&1)"
    ok "Installation successful: ${INSTALLED_VERSION}"
else
    warn "shellius --version returned a non-zero exit code. The binary may still work."
fi

# ---------------------------------------------------------------------------
# Next steps
# ---------------------------------------------------------------------------

printf '\n'
printf '  shellius %s installed successfully.\n' "${VERSION}"
printf '\n'
printf '  Get started:\n'
printf '    shellius login <your-shellius-url>\n'
printf '\n'
printf '  Useful commands:\n'
printf '    shellius --help        Show all commands\n'
printf '    shellius doctor        Check config and connectivity\n'
printf '    shellius --logout      Clear stored credentials\n'
printf '\n'
