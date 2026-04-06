# Task 9D: TUI SSH Connection

**Agent:** tui
**Status:** [ ] Pending
**Blocks:** None
**Blocked By:** 9C

## Objective
Implement SSH config management for the TUI client: write the signed certificate to disk, exec into an SSH subprocess using the certificate, and clean up credentials after the session ends. Create the main entry point.

## Deliverables
- `tui/internal/ssh/connect.go`:
  - `WriteCredentials(privateKey, certificate)` — write ephemeral private key to `~/.ssh/shellius_key`, certificate to `~/.ssh/shellius_key-cert.pub`, set permissions 600/644
  - `ExecSsh(hostname, principal, port)` — exec into `ssh -i ~/.ssh/shellius_key -o CertificateFile=~/.ssh/shellius_key-cert.pub principal@hostname -p port`, replacing the current process (syscall.Exec)
  - `Cleanup()` — securely delete `~/.ssh/shellius_key` and `~/.ssh/shellius_key-cert.pub` (overwrite with zeros before unlink)
  - Signal handler to ensure cleanup on SIGINT/SIGTERM
- `tui/internal/ssh/config.go`:
  - Optional: append/manage Shellius Host entries in `~/.ssh/config` for bookmark-style access
  - `AddHostEntry(name, hostname, principal, port)`, `RemoveHostEntry(name)`, `ListHostEntries()`
- `tui/cmd/shellius/main.go`:
  - CLI entry point with subcommands: `shellius` (launch TUI), `shellius login`, `shellius logout`, `shellius connect <server>` (direct connect mode)
  - Version flag, help text
  - Config initialization on first run

## Acceptance Criteria
- `shellius` launches the TUI interface
- `shellius connect <server>` downloads credentials and execs into SSH directly
- Private key and certificate are written with correct permissions (600 for key, 644 for cert)
- Credentials are cleaned up after SSH session ends (normal exit)
- Credentials are cleaned up on SIGINT/SIGTERM (signal handling)
- Cleanup overwrites key material with zeros before deleting files
- SSH connection uses certificate-based authentication successfully
- `shellius login` and `shellius logout` manage authentication state
