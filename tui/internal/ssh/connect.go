package ssh

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
)

// Connect launches an SSH subprocess using certificate-based authentication.
// keyPath is the private key file and certPath is the signed certificate.
// The subprocess inherits the terminal's Stdin, Stdout, and Stderr so the
// user gets a full interactive session.
//
// This function is intended to be called via tea.ExecProcess so Bubble Tea
// can hand off the terminal and resume after the session ends.
func Connect(host string, port int, user, keyPath, certPath string) error {
	portStr := strconv.Itoa(port)
	if port == 0 {
		portStr = "22"
	}

	args := []string{
		"-i", keyPath,
		"-o", "CertificateFile=" + certPath,
		"-o", "StrictHostKeyChecking=no",
		"-o", "UserKnownHostsFile=/dev/null",
		"-o", "LogLevel=ERROR",
		"-p", portStr,
		user + "@" + host,
	}

	cmd := exec.Command("ssh", args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	return cmd.Run()
}

// BuildCommand returns an *exec.Cmd configured for SSH certificate auth.
// The caller is responsible for setting Stdin/Stdout/Stderr and running it.
func BuildCommand(host string, port int, user, keyPath, certPath string) *exec.Cmd {
	portStr := strconv.Itoa(port)
	if port == 0 {
		portStr = "22"
	}

	// LogLevel is left at the default (INFO) so ssh actually emits a
	// diagnostic message on connection failures. The TUI captures stderr
	// via a tee writer in execSSH so the message survives Bubble Tea's
	// alt-screen restore.
	args := []string{
		"-i", keyPath,
		"-o", "CertificateFile=" + certPath,
		"-o", "StrictHostKeyChecking=no",
		"-o", "UserKnownHostsFile=/dev/null",
		"-o", "ConnectTimeout=10",
		"-p", portStr,
		user + "@" + host,
	}

	return exec.Command("ssh", args...)
}

// ValidateSSHAvailable checks that the ssh binary is accessible on PATH.
func ValidateSSHAvailable() error {
	if _, err := exec.LookPath("ssh"); err != nil {
		return fmt.Errorf("ssh not found in PATH: %w", err)
	}
	return nil
}
