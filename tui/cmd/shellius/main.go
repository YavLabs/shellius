package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/shellius/tui/internal/config"
	"github.com/shellius/tui/internal/tui"
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
		fmt.Println("shellius v0.1.0")
		os.Exit(0)
	}

	// Load config.
	if configPath == "" {
		var err error
		configPath, err = config.DefaultPath()
		if err != nil {
			fmt.Fprintf(os.Stderr, "shellius: cannot determine config path: %v\n", err)
			os.Exit(1)
		}
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
