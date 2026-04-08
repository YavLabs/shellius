#!/bin/sh
# Build Shellius TUI binaries for every supported platform and stage
# them in ./tui-bin/ so the backend container can serve them via
# /api/cli/bin/:file. Run this on the Shellius host before rebuilding
# the backend image.
#
# Requires: docker (for a reproducible golang:1.22 build) OR a local
# Go 1.22+ toolchain. No other deps.
#
# Usage:
#   ./scripts/build-tui-binaries.sh                 # build all 5 targets
#   ./scripts/build-tui-binaries.sh linux/amd64     # build one target
#
# Output:
#   tui-bin/shellius-linux-amd64
#   tui-bin/shellius-linux-amd64.sha256
#   tui-bin/shellius-linux-arm64   (+ .sha256)
#   tui-bin/shellius-darwin-amd64  (+ .sha256)
#   tui-bin/shellius-darwin-arm64  (+ .sha256)
#   tui-bin/shellius-windows-amd64.exe (+ .sha256)
#   tui-bin/version.txt

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$REPO_ROOT/tui-bin"
TUI_DIR="$REPO_ROOT/tui"

VERSION="${VERSION:-$(cd "$REPO_ROOT" && git describe --tags --always --dirty 2>/dev/null || echo dev)}"
COMMIT="${COMMIT:-$(cd "$REPO_ROOT" && git rev-parse --short HEAD 2>/dev/null || echo unknown)}"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

LDFLAGS="-s -w -X main.version=${VERSION} -X main.commit=${COMMIT} -X main.buildTime=${BUILD_TIME}"

# Default matrix — pairs of "goos/goarch" (space separated)
TARGETS="${*:-linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64}"

mkdir -p "$OUT_DIR"

# Prefer a local Go toolchain; fall back to docker golang:1.22.
if command -v go >/dev/null 2>&1; then
    RUNNER="local"
    echo "[build] Using local Go toolchain: $(go version)"
else
    if ! command -v docker >/dev/null 2>&1; then
        echo "[build] ERROR: neither a local 'go' binary nor 'docker' is available." >&2
        exit 1
    fi
    RUNNER="docker"
    echo "[build] Using docker golang:1.22"
fi

build_one() {
    goos="$1"
    goarch="$2"
    suffix=""
    [ "$goos" = "windows" ] && suffix=".exe"
    out_name="shellius-${goos}-${goarch}${suffix}"
    out_path="$OUT_DIR/$out_name"

    echo "[build] $goos/$goarch → $out_name"

    if [ "$RUNNER" = "local" ]; then
        ( cd "$TUI_DIR" && \
          GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 \
              go build -trimpath -ldflags "$LDFLAGS" \
              -o "$out_path" ./cmd/shellius )
    else
        docker run --rm \
            -v "$REPO_ROOT":/src \
            -v /tmp/shellius-gomodcache:/go/pkg \
            -w /src/tui \
            -e GOOS="$goos" -e GOARCH="$goarch" -e CGO_ENABLED=0 \
            -e GOFLAGS="-buildvcs=false" \
            golang:1.22 \
            go build -trimpath -buildvcs=false -ldflags "$LDFLAGS" \
                -o "/src/tui-bin/$out_name" ./cmd/shellius
    fi

    # SHA-256 sidecar
    ( cd "$OUT_DIR" && \
      ( sha256sum "$out_name" 2>/dev/null \
        || shasum -a 256 "$out_name" ) \
        > "${out_name}.sha256" )
}

for target in $TARGETS; do
    goos="${target%%/*}"
    goarch="${target##*/}"
    build_one "$goos" "$goarch"
done

# Write version.txt so /api/cli/version can report what's shipped
cat > "$OUT_DIR/version.txt" <<EOF
version=${VERSION}
commit=${COMMIT}
build_time=${BUILD_TIME}
EOF

echo
echo "[build] Done. Output:"
ls -lh "$OUT_DIR" | sed 's/^/  /'
echo
echo "[build] Next steps:"
echo "  1. docker compose -f docker-compose.prod.yml --env-file .env.prod build backend"
echo "  2. docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --no-deps backend"
echo "  3. Binaries will be served at /api/cli/bin/<name>"
