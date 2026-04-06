package auth

import (
	"os/exec"
	"runtime"
)

// OpenBrowser attempts to open the given URL in the default browser.
// This is best-effort; errors are intentionally ignored because the user can
// always visit the URL manually.
func OpenBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "linux":
		cmd = exec.Command("xdg-open", url)
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		return
	}
	// Fire-and-forget; ignore any errors.
	_ = cmd.Start()
}
