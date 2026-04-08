//go:build !windows

package sessions

import "syscall"

// pidAlive returns true when a process with the given PID exists and is
// reachable by the current user. Uses signal 0 (no-op) which succeeds
// only if the process exists and we have permission to signal it.
func pidAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil
}
