package main

import (
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/shellius/tui/internal/config"
	"github.com/shellius/tui/internal/logx"
	"github.com/shellius/tui/internal/tui"
)

// Build-time variables injected via -ldflags. Defaults are used for local
// builds without version stamping.
var (
	version   = "dev"
	commit    = "unknown"
	buildTime = "unknown"
)

func main() {
	var (
		configPath  string
		serverURL   string
		showVersion bool
		logout      bool
	)

	flag.StringVar(&configPath, "config", "", "Path to config file (default: ~/.shellius/config.yaml)")
	flag.StringVar(&serverURL, "server", "", "Shellius server URL (overrides config)")
	flag.BoolVar(&showVersion, "version", false, "Print version and exit")
	flag.BoolVar(&logout, "logout", false, "Clear stored credentials and exit")
	flag.Parse()

	if showVersion {
		fmt.Printf("shellius %s (%s, built %s)\n", version, commit, buildTime)
		os.Exit(0)
	}

	// Sub-commands are the first non-flag argument.
	args := flag.Args()
	subcmd := ""
	if len(args) > 0 {
		subcmd = args[0]
	}

	// Initialise the rolling log writer as early as possible so config.Load
	// can emit a path entry.
	logPath, err := logx.DefaultLogPath()
	if err != nil {
		fmt.Fprintf(os.Stderr, "shellius: cannot determine log path: %v\n", err)
	} else {
		logx.Init(logPath)
	}

	// Resolve config path.
	if configPath == "" {
		configPath, err = config.DefaultPath()
		if err != nil {
			fmt.Fprintf(os.Stderr, "shellius: cannot determine config path: %v\n", err)
			os.Exit(1)
		}
	}

	// "shellius doctor" does not require a fully valid config, so handle it
	// before the normal load/validate path.
	if subcmd == "doctor" {
		os.Exit(runDoctor(configPath, logPath))
	}

	cfg, err := config.Load(configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "shellius: load config: %v\n", err)
		os.Exit(1)
	}

	// Override server URL if provided on command line.
	if serverURL != "" {
		cfg.ServerURL = serverURL
	}

	// Handle --logout before starting the TUI.
	if logout {
		if err := cfg.Clear(); err != nil {
			fmt.Fprintf(os.Stderr, "shellius: logout: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("Logged out successfully.")
		os.Exit(0)
	}

	if err := tui.Run(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "shellius: %v\n", err)
		os.Exit(1)
	}
}

// runDoctor prints a health report for the Shellius TUI config and log state.
// It returns 0 on healthy, 1 on any issue.
func runDoctor(configPath, logPath string) int {
	issues := 0

	fmt.Println("Shellius TUI — doctor report")
	fmt.Println(strings.Repeat("-", 44))

	// --- Config file ---
	fmt.Printf("Config path : %s\n", configPath)

	fi, statErr := os.Stat(configPath)
	if statErr != nil {
		if os.IsNotExist(statErr) {
			fmt.Println("Config file : NOT FOUND (first run?)")
		} else {
			fmt.Printf("Config file : ERROR (%v)\n", statErr)
			issues++
		}
	} else {
		// File exists — show permissions.
		perms := fi.Mode().Perm()
		permStr := fmt.Sprintf("%04o", perms)
		if perms&0077 != 0 {
			fmt.Printf("Config perms: %s  WARN: file is world/group readable\n", permStr)
			issues++
		} else {
			fmt.Printf("Config perms: %s  OK\n", permStr)
		}
	}

	// Load config (best-effort, even if file missing).
	cfg, loadErr := config.Load(configPath)
	if loadErr != nil {
		fmt.Printf("Config load : ERROR (%v)\n", loadErr)
		issues++
	} else {
		// --- Server URL ---
		if cfg.ServerURL == "" {
			fmt.Println("Server URL  : (not set)")
			issues++
		} else {
			fmt.Printf("Server URL  : %s\n", cfg.ServerURL)
		}

		// --- Token expiry ---
		if cfg.AccessToken == "" {
			fmt.Println("Access token: (none — not logged in)")
			issues++
		} else {
			now := time.Now()
			exp := cfg.TokenExpiresAt
			if exp.IsZero() {
				fmt.Println("Token expiry: (unknown)")
			} else if now.After(exp) {
				fmt.Printf("Token expiry: EXPIRED %s ago\n", formatDuration(now.Sub(exp)))
				issues++
			} else {
				fmt.Printf("Token expiry: OK — expires in %s (at %s)\n",
					formatDuration(exp.Sub(now)),
					exp.Local().Format("2006-01-02 15:04:05"))
			}
		}

		// --- Refresh token ---
		if cfg.RefreshToken == "" {
			fmt.Println("Refresh tok : (none)")
			issues++
		} else {
			fmt.Println("Refresh tok : present")
		}

		// --- Username / org ---
		if cfg.Username != "" {
			fmt.Printf("User        : %s\n", cfg.Username)
		}
		if cfg.OrgSlug != "" {
			fmt.Printf("Org         : %s\n", cfg.OrgSlug)
		}
		if cfg.Role != "" {
			fmt.Printf("Role        : %s\n", cfg.Role)
		}
	}

	// --- Log file ---
	fmt.Println(strings.Repeat("-", 44))
	fmt.Printf("Log path    : %s\n", logPath)

	logFi, logStatErr := os.Stat(logPath)
	if logStatErr != nil {
		if os.IsNotExist(logStatErr) {
			fmt.Println("Log file    : not yet created")
		} else {
			fmt.Printf("Log file    : ERROR (%v)\n", logStatErr)
		}
	} else {
		fmt.Printf("Log size    : %d bytes\n", logFi.Size())
		// Show last 10 lines.
		recent := logx.LastLines(logPath, 10)
		if recent != "" {
			fmt.Println("Recent log entries:")
			for _, line := range strings.Split(strings.TrimRight(recent, "\n"), "\n") {
				fmt.Println("  " + line)
			}
		}
	}

	// --- Summary ---
	fmt.Println(strings.Repeat("-", 44))
	if issues == 0 {
		fmt.Println("Status      : healthy")
	} else {
		fmt.Printf("Status      : %d issue(s) found\n", issues)
	}

	if issues > 0 {
		return 1
	}
	return 0
}

// formatDuration returns a human-readable string for a duration, e.g. "2h 34m".
func formatDuration(d time.Duration) string {
	if d < 0 {
		d = -d
	}
	h := int(d.Hours())
	m := int(d.Minutes()) % 60
	s := int(d.Seconds()) % 60
	switch {
	case h > 0:
		return fmt.Sprintf("%dh %dm", h, m)
	case m > 0:
		return fmt.Sprintf("%dm %ds", m, s)
	default:
		return fmt.Sprintf("%ds", s)
	}
}
