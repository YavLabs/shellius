package sessions

import (
	"os"
	"testing"
	"time"
)

// withTempHome overrides HOME so Dir() uses a temp directory.
func withTempHome(t *testing.T) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
}

func TestStartAndClose(t *testing.T) {
	withTempHome(t)

	sess := Session{
		ServerID:   "srv-1",
		ServerName: "web01",
		Principal:  "ubuntu",
	}

	id, closeFn, err := Start(sess)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if id == "" {
		t.Error("expected non-empty session ID")
	}

	// The active session file must exist.
	dir, _ := Dir()
	activePath := dir + "/" + id + ".json"
	if _, err := os.Stat(activePath); err != nil {
		t.Errorf("active session file missing: %v", err)
	}

	// Close moves it to history.
	closeFn()
	if _, err := os.Stat(activePath); !os.IsNotExist(err) {
		t.Error("active session file should be removed after Close()")
	}

	hist, err := History()
	if err != nil {
		t.Fatalf("History: %v", err)
	}
	found := false
	for _, h := range hist {
		if h.ID == id {
			found = true
			if h.EndedAt.IsZero() {
				t.Error("history entry should have EndedAt set")
			}
		}
	}
	if !found {
		t.Errorf("session %s not found in history", id)
	}
}

func TestListFiltersDeadPIDs(t *testing.T) {
	withTempHome(t)

	// Write a session with a PID that we know is dead (PID 1 won't be "owned"
	// by us, but PID 99999999 almost certainly doesn't exist).
	fakePID := 99999999
	fakeSess := Session{
		ID:         "dead-session",
		PID:        fakePID,
		ServerID:   "srv-2",
		ServerName: "dead",
		StartedAt:  time.Now(),
		Principal:  "root",
	}
	dir, _ := Dir()
	_ = writeJSON(dir+"/dead-session.json", fakeSess)

	active, err := List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	for _, s := range active {
		if s.ID == "dead-session" {
			t.Error("dead-session should have been pruned from active list")
		}
	}

	// It should be in history now.
	hist, _ := History()
	found := false
	for _, h := range hist {
		if h.ID == "dead-session" {
			found = true
		}
	}
	if !found {
		t.Error("dead session should appear in history after pruning")
	}
}

func TestHistoryPrunesOldEntries(t *testing.T) {
	withTempHome(t)

	hd, err := histDir()
	if err != nil {
		t.Fatal(err)
	}

	// Write a session file that is 8 days old by setting its mtime.
	old := Session{
		ID:        "old-session",
		StartedAt: time.Now().Add(-8 * 24 * time.Hour),
	}
	oldPath := hd + "/old-session.json"
	_ = writeJSON(oldPath, old)
	// Set mtime to 8 days ago so pruneHistory removes it.
	eightDaysAgo := time.Now().Add(-8 * 24 * time.Hour)
	_ = os.Chtimes(oldPath, eightDaysAgo, eightDaysAgo)

	hist, err := History()
	if err != nil {
		t.Fatalf("History: %v", err)
	}
	for _, h := range hist {
		if h.ID == "old-session" {
			t.Error("old session should have been pruned from history")
		}
	}
}

func TestHistoryMaxEntries(t *testing.T) {
	withTempHome(t)

	hd, _ := histDir()
	// Write 25 history entries.
	for i := 0; i < 25; i++ {
		s := Session{
			ID:        generateID(),
			StartedAt: time.Now().Add(-time.Duration(i) * time.Minute),
		}
		_ = writeJSON(hd+"/"+s.ID+".json", s)
	}

	hist, err := History()
	if err != nil {
		t.Fatalf("History: %v", err)
	}
	if len(hist) > maxHistory {
		t.Errorf("History returned %d entries, max is %d", len(hist), maxHistory)
	}
}

func TestPidAlive(t *testing.T) {
	// Current process must be alive.
	if !pidAlive(os.Getpid()) {
		t.Error("pidAlive(os.Getpid()) returned false")
	}
	// PID 0 is never valid.
	if pidAlive(0) {
		t.Error("pidAlive(0) should return false")
	}
	// Very large PID unlikely to exist.
	if pidAlive(99999999) {
		t.Log("warning: PID 99999999 happens to exist — ignoring")
	}
}
