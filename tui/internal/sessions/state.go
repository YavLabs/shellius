// Package sessions manages the local SSH session state directory at
// ~/.shellius/sessions/. Each active session writes a JSON file while it is
// live; when it exits the file moves to ~/.shellius/sessions/history/.
// A second shellius instance (multi-window) reads the same directory so it can
// display which sessions are currently active on a given server.
package sessions

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"syscall"
	"time"

	"github.com/shellius/tui/internal/logx"
)

const (
	historyDir      = "history"
	maxHistory      = 20
	historyMaxAge   = 7 * 24 * time.Hour
)

// Session is a record of one SSH session — active or historical.
type Session struct {
	ID           string    `json:"id"`
	PID          int       `json:"pid"`
	ServerID     string    `json:"serverId"`
	ServerName   string    `json:"serverName"`
	StartedAt    time.Time `json:"startedAt"`
	LeaseExpiry  time.Time `json:"leaseExpiry,omitempty"`
	Principal    string    `json:"principal"`
	EndedAt      time.Time `json:"endedAt,omitempty"` // zero for active sessions
}

// Dir returns ~/.shellius/sessions, creating it (0700) if absent.
func Dir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("sessions: home dir: %w", err)
	}
	d := filepath.Join(home, ".shellius", "sessions")
	if err := os.MkdirAll(d, 0700); err != nil {
		return "", fmt.Errorf("sessions: mkdir: %w", err)
	}
	return d, nil
}

// histDir returns the history sub-directory, creating it if absent.
func histDir() (string, error) {
	d, err := Dir()
	if err != nil {
		return "", err
	}
	h := filepath.Join(d, historyDir)
	if err := os.MkdirAll(h, 0700); err != nil {
		return "", fmt.Errorf("sessions: mkdir history: %w", err)
	}
	return h, nil
}

// Start writes a session record to the state dir and returns the session ID
// plus a Close func that should be deferred (moves the record to history).
func Start(sess Session) (id string, close func(), err error) {
	if sess.ID == "" {
		sess.ID = generateID()
	}
	if sess.StartedAt.IsZero() {
		sess.StartedAt = time.Now()
	}
	if sess.PID == 0 {
		sess.PID = os.Getpid()
	}

	dir, err := Dir()
	if err != nil {
		return "", nil, err
	}

	active := filepath.Join(dir, sess.ID+".json")
	if err := writeJSON(active, sess); err != nil {
		return "", nil, fmt.Errorf("sessions: write active: %w", err)
	}
	logx.Infof("sessions: started %s pid=%d server=%s", sess.ID, sess.PID, sess.ServerName)

	closeFunc := func() {
		sess.EndedAt = time.Now()
		hd, herr := histDir()
		if herr != nil {
			logx.Warnf("sessions: close: %v", herr)
			_ = os.Remove(active)
			return
		}
		hist := filepath.Join(hd, sess.ID+".json")
		if werr := writeJSON(hist, sess); werr != nil {
			logx.Warnf("sessions: write history: %v", werr)
		}
		_ = os.Remove(active)
		logx.Infof("sessions: closed %s (moved to history)", sess.ID)
	}
	return sess.ID, closeFunc, nil
}

// List returns all sessions whose PID is still alive. Dead sessions (process
// gone) are pruned to the history directory. It also prunes history entries
// older than 7 days.
func List() ([]Session, error) {
	dir, err := Dir()
	if err != nil {
		return nil, err
	}

	files, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return nil, fmt.Errorf("sessions: list glob: %w", err)
	}

	var active []Session
	for _, f := range files {
		var s Session
		if err := readJSON(f, &s); err != nil {
			logx.Warnf("sessions: parse %s: %v", f, err)
			continue
		}
		if pidAlive(s.PID) {
			active = append(active, s)
		} else {
			// Process gone — move to history.
			s.EndedAt = time.Now()
			hd, herr := histDir()
			if herr == nil {
				_ = writeJSON(filepath.Join(hd, s.ID+".json"), s)
			}
			_ = os.Remove(f)
		}
	}

	// Prune old history entries.
	_ = pruneHistory()

	sort.Slice(active, func(i, j int) bool {
		return active[i].StartedAt.Before(active[j].StartedAt)
	})
	return active, nil
}

// History returns up to the last 20 history entries, newest first.
func History() ([]Session, error) {
	_ = pruneHistory()

	hd, err := histDir()
	if err != nil {
		return nil, err
	}

	files, err := filepath.Glob(filepath.Join(hd, "*.json"))
	if err != nil {
		return nil, fmt.Errorf("sessions: history glob: %w", err)
	}

	var hist []Session
	for _, f := range files {
		var s Session
		if err := readJSON(f, &s); err != nil {
			continue
		}
		hist = append(hist, s)
	}

	// Sort newest first.
	sort.Slice(hist, func(i, j int) bool {
		return hist[i].StartedAt.After(hist[j].StartedAt)
	})

	if len(hist) > maxHistory {
		hist = hist[:maxHistory]
	}
	return hist, nil
}

// pruneHistory removes history entries older than 7 days.
func pruneHistory() error {
	hd, err := histDir()
	if err != nil {
		return err
	}
	files, err := filepath.Glob(filepath.Join(hd, "*.json"))
	if err != nil {
		return err
	}
	cutoff := time.Now().Add(-historyMaxAge)
	for _, f := range files {
		fi, err := os.Stat(f)
		if err != nil {
			continue
		}
		if fi.ModTime().Before(cutoff) {
			_ = os.Remove(f)
		}
	}
	return nil
}

// pidAlive returns true when a process with the given PID exists and is
// reachable by the current user (signal 0 is a no-op but tests existence).
func pidAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil
}

// generateID returns a unique session ID based on current time and PID.
func generateID() string {
	return fmt.Sprintf("%d-%d", time.Now().UnixNano(), os.Getpid())
}

// writeJSON marshals v to path with mode 0600.
func writeJSON(path string, v interface{}) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0600)
}

// readJSON reads and unmarshals JSON from path into v.
func readJSON(path string, v interface{}) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}
