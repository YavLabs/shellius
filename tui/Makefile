BINARY   := shellius
MODULE   := github.com/shellius/tui
CMD      := ./cmd/shellius
BINDIR   := bin
VERSION  := v0.1.0
LDFLAGS  := -ldflags "-s -w -X main.version=$(VERSION)"

PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64

.PHONY: all build build-all install clean tidy vet test

all: build

## build: compile for the current platform
build:
	@mkdir -p $(BINDIR)
	go build $(LDFLAGS) -o $(BINDIR)/$(BINARY) $(CMD)
	@echo "built $(BINDIR)/$(BINARY)"

## build-all: cross-compile for all supported platforms
build-all:
	@mkdir -p $(BINDIR)
	$(foreach platform,$(PLATFORMS), \
		$(eval OS   := $(word 1,$(subst /, ,$(platform)))) \
		$(eval ARCH := $(word 2,$(subst /, ,$(platform)))) \
		$(eval EXT  := $(if $(filter windows,$(OS)),.exe,)) \
		GOOS=$(OS) GOARCH=$(ARCH) go build $(LDFLAGS) \
			-o $(BINDIR)/$(BINARY)-$(OS)-$(ARCH)$(EXT) $(CMD); \
	)
	@echo "cross-compiled binaries in $(BINDIR)/"

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
