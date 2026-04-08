//go:build windows

package sessions

import "os"

// pidAlive returns true when a process with the given PID exists.
// On Windows, os.FindProcess always succeeds so we use Signal(nil) as a
// liveness probe.
func pidAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	// A no-op signal — on Windows this returns nil if the process is
	// running and an error otherwise.
	return proc.Signal(nil) == nil
}
