// Package rdp launches a native RDP client for an approved Shellius RDP
// access request.
//
// What the backend hands us (backend/src/services/accessRequestService.js,
// generateRdpFile): a Windows MSTSC-format .rdp profile containing the
// address, port, username, display and gateway settings — and NO credential
// of any kind. Not the host's RDP password, and deliberately not the
// Guacamole connection token either, because that token's plaintext contains
// the password. The comment in that function is explicit that putting it in a
// downloaded file was "a credential on disk".
//
// Two consequences shape this package:
//
//  1. There is no password to protect. The file is still written 0600 inside
//     a 0700 directory and removed afterwards — it discloses internal
//     addressing and a valid account name, which is worth not leaving in a
//     world-readable /tmp — but the security of the connection does not rest
//     on that file staying secret.
//
//  2. A .rdp file only connects from a machine that can already reach the
//     host. Credential injection happens exclusively in the browser session
//     (WebSocket → guacd). So the web client is not a consolation prize, it
//     is the path that always works, and every failure here must fall back to
//     it rather than dead-end.
//
// Nothing in this package goes anywhere near a shell: every launch is
// exec.Command with an explicit argument vector, so a hostname or username
// containing shell metacharacters is passed through as one literal argument.
package rdp

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/shellius/tui/internal/logx"
)

// Result describes a successful launch.
type Result struct {
	// Client is the human-readable name of the program that was started.
	Client string
	// Path is where the .rdp profile was written.
	Path string
}

// ErrNoClient is returned when no RDP client could be found on this machine.
// The caller should fall back to the web client.
var ErrNoClient = fmt.Errorf("no RDP client found")

// candidate is one way of starting a client with a .rdp file.
type candidate struct {
	name string
	bin  string
	// args builds the argument vector, given the path to the .rdp file.
	args func(path string) []string
}

// candidates returns the clients to try, in order, for the current OS.
//
// Windows: mstsc is part of the OS, so it is the only entry and it is
// essentially guaranteed to resolve.
//
// macOS: `open -W <file>` hands the file to whatever app is registered for
// .rdp — Windows App (the current name) or Microsoft Remote Desktop (the old
// one). Going through `open` rather than naming the app means we do not have
// to track Microsoft's renames, and -W makes it wait so the profile can be
// deleted afterwards. If nothing is registered, `open` exits non-zero and we
// fall through to the web client.
//
// Linux: FreeRDP and Remmina both accept a .rdp profile. xfreerdp3 is tried
// before xfreerdp because distributions that ship both leave the 2.x binary
// as a compatibility stub.
func candidates() []candidate {
	switch runtime.GOOS {
	case "windows":
		return []candidate{
			{name: "mstsc", bin: "mstsc", args: func(p string) []string { return []string{p} }},
		}
	case "darwin":
		return []candidate{
			{name: "Remote Desktop", bin: "open", args: func(p string) []string { return []string{"-W", p} }},
		}
	default:
		return []candidate{
			{name: "xfreerdp3", bin: "xfreerdp3", args: func(p string) []string { return []string{p} }},
			{name: "xfreerdp", bin: "xfreerdp", args: func(p string) []string { return []string{p} }},
			{name: "wlfreerdp", bin: "wlfreerdp", args: func(p string) []string { return []string{p} }},
			{name: "remmina", bin: "remmina", args: func(p string) []string { return []string{"-c", p} }},
		}
	}
}

// Seams for tests. The real ones touch $PATH and fork processes, neither of
// which belongs in a unit test.
var (
	lookPath  = exec.LookPath
	startCmd  = func(c *exec.Cmd) error { return c.Start() }
	waitCmd   = func(c *exec.Cmd) error { return c.Wait() }
	tempDirFn = os.MkdirTemp
)

// Available reports whether a native RDP client exists on this machine. The
// UI uses it to decide what to offer before it asks the API for anything.
func Available() bool {
	for _, c := range candidates() {
		if _, err := lookPath(c.bin); err == nil {
			return true
		}
	}
	return false
}

// profileLifetime is how long the .rdp profile is allowed to survive if the
// client never exits.
//
// Every RDP client reads the profile once, at startup, so deleting it while a
// session is running is harmless. The timer exists because a session can last
// all day and the alternative — keeping the file until the client quits —
// would leave it lying around for hours.
const profileLifetime = 2 * time.Minute

// staleAfter is how old an abandoned profile directory must be before a later
// run deletes it. This is the backstop for the one case cleanup cannot
// otherwise cover: the user quits the CLI while a client is still running, so
// the goroutine that would have deleted the directory dies with the process.
const staleAfter = time.Hour

const dirPrefix = "shellius-rdp-"

// Launch writes the .rdp profile to a private directory and starts a native
// client on it.
//
// It returns ErrNoClient when no client is installed, and a plain error when
// the profile cannot be written (a read-only or full temp directory, a
// $TMPDIR that does not exist). In both cases the caller must fall back to
// the web client — which is the only option on a headless box anyway.
func Launch(filename, content string) (Result, error) {
	// Best-effort tidy-up of anything a previous run abandoned. Failures here
	// are irrelevant to this launch.
	sweepStale()

	if strings.TrimSpace(content) == "" {
		return Result{}, fmt.Errorf("the server returned an empty RDP profile")
	}

	// Resolve the client BEFORE writing anything, so the "no client" case
	// leaves no file behind at all.
	var chosen *candidate
	var bin string
	for _, c := range candidates() {
		path, err := lookPath(c.bin)
		if err != nil {
			continue
		}
		cc := c
		chosen = &cc
		bin = path
		break
	}
	if chosen == nil {
		return Result{}, ErrNoClient
	}

	dir, err := tempDirFn("", dirPrefix)
	if err != nil {
		return Result{}, fmt.Errorf("create private directory for the RDP profile: %w", err)
	}
	// MkdirTemp already creates 0700, but say so explicitly: the guarantee
	// this file needs is that no other local user can read the address and
	// account name out of it, and that should not depend on a default.
	if err := os.Chmod(dir, 0700); err != nil {
		_ = os.RemoveAll(dir)
		return Result{}, fmt.Errorf("secure the RDP profile directory: %w", err)
	}

	// The server chooses the filename ("shellius-<id>.rdp"). Take only its
	// base name: a filename containing a path separator would otherwise let
	// the response decide where on disk the CLI writes.
	name := filepath.Base(filepath.Clean(filename))
	if name == "" || name == "." || name == string(filepath.Separator) || name == ".." {
		name = "shellius.rdp"
	}
	if !strings.HasSuffix(strings.ToLower(name), ".rdp") {
		// Windows dispatches on the extension; without it mstsc will not
		// recognise the file.
		name += ".rdp"
	}
	path := filepath.Join(dir, name)

	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		_ = os.RemoveAll(dir)
		return Result{}, fmt.Errorf("write the RDP profile: %w", err)
	}

	cmd := exec.Command(bin, chosen.args(path)...)
	// The client owns a window, not this terminal. Giving it our stdin would
	// let it steal the keystrokes the TUI is reading.
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil

	if err := startCmd(cmd); err != nil {
		_ = os.RemoveAll(dir)
		return Result{}, fmt.Errorf("start %s: %w", chosen.name, err)
	}

	logx.Infof("rdp: launched %s with profile %s", chosen.name, path)
	go cleanupAfter(cmd, dir)

	return Result{Client: chosen.name, Path: path}, nil
}

// cleanupAfter removes the profile directory once the client exits, or after
// profileLifetime — whichever comes first.
//
// Reaping the child matters as much as the delete: without a Wait the client
// stays a zombie for as long as the CLI runs.
func cleanupAfter(cmd *exec.Cmd, dir string) {
	done := make(chan struct{})
	go func() {
		_ = waitCmd(cmd)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(profileLifetime):
	}
	if err := os.RemoveAll(dir); err != nil {
		logx.Warnf("rdp: could not remove the RDP profile directory %s: %v", dir, err)
		return
	}
	logx.Infof("rdp: removed the RDP profile directory %s", dir)
}

// sweepStale deletes profile directories left behind by an earlier run that
// was killed before its cleanup goroutine could finish.
func sweepStale() {
	base := os.TempDir()
	entries, err := os.ReadDir(base)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-staleAfter)
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), dirPrefix) {
			continue
		}
		info, err := e.Info()
		if err != nil || info.ModTime().After(cutoff) {
			continue
		}
		full := filepath.Join(base, e.Name())
		if err := os.RemoveAll(full); err == nil {
			logx.Infof("rdp: swept abandoned RDP profile directory %s", full)
		}
	}
}
