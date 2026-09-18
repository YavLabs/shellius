BINARY   := shellius
MODULE   := github.com/shellius/tui
CMD      := ./cmd/shellius
BINDIR   := bin

# Version stamping. Default reads the repo-root VERSION file (kept in sync
# with backend/frontend package.json by `node scripts/version.mjs sync`);
# override on the command line for a specific TUI release, e.g.:
#   make build VERSION=1.1.0
VERSION   ?= $(shell cat $(CURDIR)/../VERSION 2>/dev/null || echo dev)
COMMIT    ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
BUILD_TIME ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)

LDFLAGS := -ldflags "-s -w \
	-X main.version=$(VERSION) \
	-X main.commit=$(COMMIT) \
	-X main.buildTime=$(BUILD_TIME)"

PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64

.PHONY: all build build-all install clean tidy vet test

all: build

## build: compile for the current platform
build:
	@mkdir -p $(BINDIR)
	go build $(LDFLAGS) -trimpath -o $(BINDIR)/$(BINARY) $(CMD)
	@echo "built $(BINDIR)/$(BINARY)"

## build-all: cross-compile for all supported platforms
build-all:
	@mkdir -p $(BINDIR)
	$(foreach platform,$(PLATFORMS), \
		$(eval OS   := $(word 1,$(subst /, ,$(platform)))) \
		$(eval ARCH := $(word 2,$(subst /, ,$(platform)))) \
		$(eval EXT  := $(if $(filter windows,$(OS)),.exe,)) \
		GOOS=$(OS) GOARCH=$(ARCH) CGO_ENABLED=0 go build $(LDFLAGS) -trimpath \
			-o $(BINDIR)/$(BINARY)-$(OS)-$(ARCH)$(EXT) $(CMD); \
	)
	@echo "cross-compiled binaries in $(BINDIR)/"

## checksums: generate SHA-256 sidecar files for all binaries in bin/
checksums:
	@cd $(BINDIR) && for f in $(BINARY)-*; do \
		[ -f "$$f" ] || continue; \
		sha256sum "$$f" > "$${f%.exe}.sha256"; \
		echo "  $$f -> $${f%.exe}.sha256"; \
	done

## install: install to GOPATH/bin
install:
	go install $(LDFLAGS) $(CMD)
	@echo "installed $(BINARY)"

## tidy: tidy go modules
tidy:
	go mod tidy

## vet: run go vet
vet:
	go vet ./...

## test: run tests
test:
	go test ./...

## clean: remove build artifacts
clean:
	rm -rf $(BINDIR)
	@echo "cleaned $(BINDIR)/"
