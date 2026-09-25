package rdp

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// stubClients makes exactly the named binaries resolvable and records every
// launch, without running anything. The real seams fork processes and read
// $PATH, neither of which belongs in a unit test — and the OS the test runs
// on must not decide whether it passes.
func stubClients(t *testing.T, available map[string]bool) *[]*exec.Cmd {
	t.Helper()

	var mu sync.Mutex
	launched := []*exec.Cmd{}

	origLook, origStart, origWait := lookPath, startCmd, waitCmd
	lookPath = func(bin string) (string, error) {
		if available[bin] {
			return "/usr/bin/" + bin, nil
		}
		return "", exec.ErrNotFound
	}
	startCmd = func(c *exec.Cmd) error {
		mu.Lock()
		launched = append(launched, c)
		mu.Unlock()
		return nil
	}
	waitCmd = func(c *exec.Cmd) error { return nil }

	t.Cleanup(func() { lookPath, startCmd, waitCmd = origLook, origStart, origWait })
	return &launched
}

// allClients makes every candidate for this OS resolvable, so the test does
// not have to know which platform it is running on.
func allClients(t *testing.T) *[]*exec.Cmd {
	t.Helper()
	avail := map[string]bool{}
	for _, c := range candidates() {
		avail[c.bin] = true
	}
	return stubClients(t, avail)
}

func TestLaunchWritesThePrivateProfileAndStartsAClient(t *testing.T) {
	launched := allClients(t)

	res, err := Launch("shellius-ar-1.rdp", "full address:s:10.0.0.4:3389\r\nusername:s:Administrator")
	if err != nil {
		t.Fatalf("Launch: %v", err)
	}
	if res.Client == "" {
		t.Fatal("no client name reported")
	}
	if len(*launched) != 1 {
		t.Fatalf("started %d processes, want 1", len(*launched))
	}
	// The profile path must appear verbatim in the argument vector. It is
	// passed as one exec argument, never through a shell, so a path or a
	// hostname containing shell metacharacters cannot be re-interpreted.
	args := (*launched)[0].Args
	found := false
	for _, a := range args {
		if a == res.Path {
			found = true
		}
	}
	if !found {
		t.Fatalf("the profile path %q is not in the argument vector %v", res.Path, args)
	}

	fi, statErr := os.Stat(res.Path)
	if statErr != nil {
		t.Fatalf("the profile was not written: %v", statErr)
	}
	// Not because the file is a credential — the backend writes no password
	// into it — but because it discloses internal addressing and a valid
	// account name, and that has no business being readable by other local
	// users.
	if perm := fi.Mode().Perm(); perm != 0600 {
		t.Fatalf("profile mode = %04o, want 0600", perm)
	}
	dirFi, dirErr := os.Stat(filepath.Dir(res.Path))
	if dirErr != nil {
		t.Fatalf("stat profile directory: %v", dirErr)
	}
	if perm := dirFi.Mode().Perm(); perm != 0700 {
		t.Fatalf("profile directory mode = %04o, want 0700", perm)
	}
	_ = os.RemoveAll(filepath.Dir(res.Path))
}

// No client installed is the normal case on a server or a headless box, and
// it must be reported distinctly so the caller can go to the web client
// rather than show an error.
func TestLaunchWithoutAnyClientWritesNothing(t *testing.T) {
	stubClients(t, map[string]bool{})

	before := countProfileDirs(t)
	_, err := Launch("x.rdp", "content")
	if !errors.Is(err, ErrNoClient) {
		t.Fatalf("err = %v, want ErrNoClient", err)
	}
	if after := countProfileDirs(t); after != before {
		t.Fatalf("a profile directory was left behind when no client exists (%d -> %d)", before, after)
	}
}

// The response chooses the filename. A name containing a path separator must
// not let the server decide where on disk the CLI writes.
func TestLaunchConfinesTheFilenameToItsOwnDirectory(t *testing.T) {
	launched := allClients(t)

	res, err := Launch("../../../../etc/cron.d/evil", "content")
	if err != nil {
		t.Fatalf("Launch: %v", err)
	}
	defer os.RemoveAll(filepath.Dir(res.Path))

	dir := filepath.Dir(res.Path)
	if !strings.HasPrefix(filepath.Base(dir), dirPrefix) {
		t.Fatalf("profile written to %q, outside a private profile directory", res.Path)
	}
	if strings.Contains(filepath.Base(res.Path), "/") || strings.Contains(filepath.Base(res.Path), "\\") {
		t.Fatalf("the filename kept a path separator: %q", res.Path)
	}
	if len(*launched) != 1 {
		t.Fatalf("started %d processes, want 1", len(*launched))
	}
}

// Windows dispatches on the extension; without .rdp, mstsc does not
// recognise the file at all.
func TestLaunchForcesTheRdpExtension(t *testing.T) {
	allClients(t)

	res, err := Launch("profile", "content")
	if err != nil {
		t.Fatalf("Launch: %v", err)
	}
	defer os.RemoveAll(filepath.Dir(res.Path))

	if !strings.HasSuffix(res.Path, ".rdp") {
		t.Fatalf("path = %q, want a .rdp suffix", res.Path)
	}
}

// Handing an empty profile to a client produces a baffling client-side error;
// refusing it here lets the caller fall back to the web client instead.
func TestLaunchRefusesAnEmptyProfile(t *testing.T) {
	allClients(t)

	if _, err := Launch("x.rdp", "   \n"); err == nil {
		t.Fatal("expected an error for an empty profile")
	}
}

// An unwritable or missing temp directory must surface as an error the caller
// can fall back from, not a panic or a silent success.
func TestLaunchReportsAnUnwritableTempDirectory(t *testing.T) {
	allClients(t)

	orig := tempDirFn
	tempDirFn = func(dir, pattern string) (string, error) { return "", os.ErrPermission }
	defer func() { tempDirFn = orig }()

	_, err := Launch("x.rdp", "content")
	if err == nil {
		t.Fatal("expected an error when the profile directory cannot be created")
	}
	if errors.Is(err, ErrNoClient) {
		t.Fatal("an unwritable temp directory was misreported as a missing client")
	}
}

// A client that cannot be started must not leave the profile behind.
func TestLaunchRemovesTheProfileWhenTheClientWillNotStart(t *testing.T) {
	allClients(t)
	orig := startCmd
	startCmd = func(c *exec.Cmd) error { return errors.New("exec format error") }
	defer func() { startCmd = orig }()

	before := countProfileDirs(t)
	if _, err := Launch("x.rdp", "content"); err == nil {
		t.Fatal("expected an error when the client cannot be started")
	}
	if after := countProfileDirs(t); after != before {
		t.Fatalf("the profile survived a failed launch (%d -> %d)", before, after)
	}
}

// The profile is removed once the client exits. Clients read it once at
// startup, so this is safe while a session is still running.
func TestProfileIsDeletedAfterTheClientExits(t *testing.T) {
	allClients(t)

	res, err := Launch("x.rdp", "content")
	if err != nil {
		t.Fatalf("Launch: %v", err)
	}
	dir := filepath.Dir(res.Path)
	defer os.RemoveAll(dir)

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, statErr := os.Stat(dir); os.IsNotExist(statErr) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the profile directory was not removed after the client exited")
}

// The one case cleanup cannot cover is the CLI being killed while a client
// runs, which strands a directory. A later run sweeps it.
func TestSweepStaleRemovesAbandonedProfileDirectories(t *testing.T) {
	old, err := os.MkdirTemp("", dirPrefix)
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	fresh, err := os.MkdirTemp("", dirPrefix)
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	defer os.RemoveAll(fresh)

	past := time.Now().Add(-2 * staleAfter)
	if err := os.Chtimes(old, past, past); err != nil {
		t.Fatalf("Chtimes: %v", err)
	}

	sweepStale()

	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatal("an abandoned profile directory was not swept")
		_ = os.RemoveAll(old)
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatal("a directory from a live session was swept out from under it")
	}
}

func TestAvailableReflectsWhatIsInstalled(t *testing.T) {
	stubClients(t, map[string]bool{})
	if Available() {
		t.Fatal("Available() = true with nothing installed")
	}
	allClients(t)
	if !Available() {
		t.Fatal("Available() = false with a client installed")
	}
}

func countProfileDirs(t *testing.T) int {
	t.Helper()
	entries, err := os.ReadDir(os.TempDir())
	if err != nil {
		t.Fatalf("read temp dir: %v", err)
	}
	n := 0
	for _, e := range entries {
		if e.IsDir() && strings.HasPrefix(e.Name(), dirPrefix) {
			n++
		}
	}
	return n
}
