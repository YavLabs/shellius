package ssh

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/shellius/tui/internal/api"
)

// WriteTempCreds writes the private key and signed certificate from creds into
// a temporary directory. It returns the paths to both files and a cleanup
// function that securely removes the directory. The caller MUST call cleanup
// when done.
func WriteTempCreds(creds api.SshCreds) (keyPath, certPath string, cleanup func(), err error) {
	dir, err := os.MkdirTemp("", "shellius-ssh-*")
	if err != nil {
		return "", "", nil, fmt.Errorf("create temp dir: %w", err)
	}

	cleanup = func() {
		// Overwrite key material with zeros before removal.
		for _, p := range []string{filepath.Join(dir, "id"), filepath.Join(dir, "id-cert.pub")} {
			if info, statErr := os.Stat(p); statErr == nil && info.Size() > 0 {
				zeros := make([]byte, info.Size())
				_ = os.WriteFile(p, zeros, 0600)
			}
		}
		_ = os.RemoveAll(dir)
	}

	keyPath = filepath.Join(dir, "id")
	certPath = filepath.Join(dir, "id-cert.pub")

	if err := os.WriteFile(keyPath, []byte(creds.PrivateKey), 0600); err != nil {
		cleanup()
		return "", "", nil, fmt.Errorf("write private key: %w", err)
	}

	if err := os.WriteFile(certPath, []byte(creds.Certificate), 0644); err != nil {
		cleanup()
		return "", "", nil, fmt.Errorf("write certificate: %w", err)
	}

	return keyPath, certPath, cleanup, nil
}
