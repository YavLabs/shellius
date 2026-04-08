package config

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/shellius/tui/internal/logx"
	"gopkg.in/yaml.v3"
)

const (
	configDirName   = ".shellius"
	configFileName  = "config.yaml"
	credsFileName   = "credentials"
	migratedMarker  = ".migrated-22g"
)

// Prefs holds non-secret user preferences stored in ~/.shellius/config.yaml.
type Prefs struct {
	ServerURL string `yaml:"serverURL"`
	OrgSlug   string `yaml:"orgSlug,omitempty"`
	Theme     string `yaml:"theme,omitempty"`
	Keybinds  string `yaml:"keybinds,omitempty"`
	CacheTtl  int    `yaml:"cacheTtl,omitempty"` // seconds; 0 = use default
	LogLevel  string `yaml:"logLevel,omitempty"`
}

// Credentials holds secrets stored in ~/.shellius/credentials (mode 0600).
type Credentials struct {
	AccessToken    string    `yaml:"accessToken"`
	RefreshToken   string    `yaml:"refreshToken"`
	TokenExpiresAt time.Time `yaml:"tokenExpiresAt"`
	Username       string    `yaml:"username"`
	Role           string    `yaml:"role"`
	OrgID          string    `yaml:"orgId"`
	OrgSlug        string    `yaml:"orgSlug,omitempty"`
}

// Config is the unified view presented to callers. It merges Prefs and
// Credentials into a single struct so existing call sites need minimal changes.
type Config struct {
	// --- Prefs fields (config.yaml) ---
	ServerURL string
	Theme     string
	Keybinds  string
	CacheTtl  int
	LogLevel  string

	// --- Credential fields (credentials) ---
	AccessToken    string
	RefreshToken   string
	TokenExpiresAt time.Time
	Username       string
	Role           string
	OrgID          string
	OrgSlug        string

	// internal paths
	configPath string
	credsPath  string
}

// DefaultPath returns ~/.shellius/config.yaml — kept for CLI backward compat.
func DefaultPath() (string, error) {
	dir, err := defaultDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, configFileName), nil
}

// defaultDir returns ~/.shellius, creating it (0700) if needed.
func defaultDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot determine home directory: %w", err)
	}
	d := filepath.Join(home, configDirName)
	if err := os.MkdirAll(d, 0700); err != nil {
		return "", fmt.Errorf("create config dir: %w", err)
	}
	return d, nil
}

// derivePaths computes the config and credentials file paths from a config.yaml
// path supplied by the caller (or from DefaultPath).
func derivePaths(configPath string) (cfgPath, credsPath string) {
	dir := filepath.Dir(configPath)
	return configPath, filepath.Join(dir, credsFileName)
}

// Load reads prefs from configPath and credentials from the sibling credentials
// file. Missing files are not errors — the zero Config is returned. If the
// credentials file exists with permissions looser than 0600 the load fails with
// a clear actionable message.
//
// Migration: if the old monolithic config.yaml contains token fields they are
// moved to the credentials file on the first load (one-shot, guarded by
// .migrated-22g in the config dir).
func Load(configPath string) (*Config, error) {
	cfgPath, credsPath := derivePaths(configPath)
	cfg := &Config{configPath: cfgPath, credsPath: credsPath}

	absPath, _ := filepath.Abs(cfgPath)
	logx.Infof("config load: path=%s", absPath)

	// --- load prefs ---
	data, err := os.ReadFile(cfgPath)
	if err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("read config: %w", err)
	}

	// monolithicConfig is used to detect the old schema that mixed prefs + tokens.
	var monolithic struct {
		ServerURL      string    `yaml:"serverURL"`
		OrgSlug        string    `yaml:"orgSlug"`
		Theme          string    `yaml:"theme"`
		Keybinds       string    `yaml:"keybinds"`
		CacheTtl       int       `yaml:"cacheTtl"`
		LogLevel       string    `yaml:"logLevel"`
		// Legacy credential fields — present only when migration is needed.
		AccessToken    string    `yaml:"accessToken"`
		RefreshToken   string    `yaml:"refreshToken"`
		TokenExpiresAt time.Time `yaml:"tokenExpiresAt"`
		Username       string    `yaml:"username"`
		Role           string    `yaml:"role"`
		OrgID          string    `yaml:"orgID"`
	}

	if len(data) > 0 {
		if err := yaml.Unmarshal(data, &monolithic); err != nil {
			return nil, fmt.Errorf("parse config: %w", err)
		}
	}

	cfg.ServerURL = monolithic.ServerURL
	cfg.OrgSlug = monolithic.OrgSlug
	cfg.Theme = monolithic.Theme
	cfg.Keybinds = monolithic.Keybinds
	cfg.CacheTtl = monolithic.CacheTtl
	cfg.LogLevel = monolithic.LogLevel

	// --- migration (one-shot) ---
	dir := filepath.Dir(cfgPath)
	markerPath := filepath.Join(dir, migratedMarker)
	needsMigration := false
	if _, mErr := os.Stat(markerPath); os.IsNotExist(mErr) {
		// Marker absent: check if old config has token data.
		if monolithic.AccessToken != "" || monolithic.RefreshToken != "" {
			needsMigration = true
		}
	}

	if needsMigration {
		logx.Infof("config: migrating token fields from config.yaml to credentials")
		migCreds := Credentials{
			AccessToken:    monolithic.AccessToken,
			RefreshToken:   monolithic.RefreshToken,
			TokenExpiresAt: monolithic.TokenExpiresAt,
			Username:       monolithic.Username,
			Role:           monolithic.Role,
			OrgID:          monolithic.OrgID,
			OrgSlug:        monolithic.OrgSlug,
		}
		if err := writeCredentials(credsPath, migCreds); err != nil {
			return nil, fmt.Errorf("migrate credentials: %w", err)
		}
		// Rewrite config.yaml without token fields.
		prefs := Prefs{
			ServerURL: monolithic.ServerURL,
			OrgSlug:   monolithic.OrgSlug,
			Theme:     monolithic.Theme,
			Keybinds:  monolithic.Keybinds,
			CacheTtl:  monolithic.CacheTtl,
			LogLevel:  monolithic.LogLevel,
		}
		if err := writePrefs(cfgPath, prefs); err != nil {
			return nil, fmt.Errorf("migrate config rewrite: %w", err)
		}
		// Write the marker so migration does not repeat.
		if err := os.WriteFile(markerPath, []byte("migrated\n"), 0600); err != nil {
			logx.Warnf("config: could not write migration marker: %v", err)
		}
		logx.Infof("config: migration complete — tokens moved to %s", credsPath)
		// Populate cfg from migrated data.
		cfg.AccessToken = migCreds.AccessToken
		cfg.RefreshToken = migCreds.RefreshToken
		cfg.TokenExpiresAt = migCreds.TokenExpiresAt
		cfg.Username = migCreds.Username
		cfg.Role = migCreds.Role
		cfg.OrgID = migCreds.OrgID
		if cfg.OrgSlug == "" {
			cfg.OrgSlug = migCreds.OrgSlug
		}
	} else {
		// --- load credentials ---
		creds, err := loadCredentials(credsPath)
		if err != nil {
			return nil, err // error already contains path + actionable hint
		}
		cfg.AccessToken = creds.AccessToken
		cfg.RefreshToken = creds.RefreshToken
		cfg.TokenExpiresAt = creds.TokenExpiresAt
		cfg.Username = creds.Username
		cfg.Role = creds.Role
		cfg.OrgID = creds.OrgID
		if cfg.OrgSlug == "" {
			cfg.OrgSlug = creds.OrgSlug
		}
	}

	// Ensure migration marker exists after a clean load too (first run after upgrade
	// where no tokens were in config.yaml).
	if _, mErr := os.Stat(markerPath); os.IsNotExist(mErr) {
		_ = os.WriteFile(markerPath, []byte("migrated\n"), 0600)
	}

	logx.Infof("config load: ok (serverURL=%s username=%s)", cfg.ServerURL, cfg.Username)
	return cfg, nil
}

// loadCredentials reads the credentials file, enforcing strict 0600 permissions.
func loadCredentials(path string) (Credentials, error) {
	var creds Credentials
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return creds, nil
	}
	if err != nil {
		return creds, fmt.Errorf("read credentials: %w", err)
	}

	// Enforce 0600 — refuse to load if looser.
	fi, statErr := os.Stat(path)
	if statErr == nil {
		perm := fi.Mode().Perm()
		if perm&0177 != 0 { // any bits beyond owner-read/write set?
			return creds, fmt.Errorf(
				"credentials file %s has permissions %04o — expected 0600.\n"+
					"Fix with: chmod 0600 %s",
				path, perm, path,
			)
		}
	}

	if err := yaml.Unmarshal(data, &creds); err != nil {
		return creds, fmt.Errorf("parse credentials: %w", err)
	}
	return creds, nil
}

// writeCredentials marshals creds to path with mode 0600.
func writeCredentials(path string, creds Credentials) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}
	data, err := yaml.Marshal(creds)
	if err != nil {
		return fmt.Errorf("marshal credentials: %w", err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		return fmt.Errorf("write credentials: %w", err)
	}
	return nil
}

// writePrefs marshals prefs to path with mode 0644.
func writePrefs(path string, prefs Prefs) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}
	data, err := yaml.Marshal(prefs)
	if err != nil {
		return fmt.Errorf("marshal prefs: %w", err)
	}
	if err := os.WriteFile(path, data, 0644); err != nil { //nolint:gosec — intentionally 0644
		return fmt.Errorf("write config: %w", err)
	}
	return nil
}

// Save writes prefs to config.yaml (0644) and credentials to the credentials
// file (0600).
func (c *Config) Save() error {
	prefs := Prefs{
		ServerURL: c.ServerURL,
		OrgSlug:   c.OrgSlug,
		Theme:     c.Theme,
		Keybinds:  c.Keybinds,
		CacheTtl:  c.CacheTtl,
		LogLevel:  c.LogLevel,
	}
	if err := writePrefs(c.configPath, prefs); err != nil {
		return err
	}

	creds := Credentials{
		AccessToken:    c.AccessToken,
		RefreshToken:   c.RefreshToken,
		TokenExpiresAt: c.TokenExpiresAt,
		Username:       c.Username,
		Role:           c.Role,
		OrgID:          c.OrgID,
		OrgSlug:        c.OrgSlug,
	}
	return writeCredentials(c.credsPath, creds)
}

// Clear removes the credentials file. Prefs (config.yaml) are untouched.
// This is the correct logout operation.
func (c *Config) Clear() error {
	if err := os.Remove(c.credsPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove credentials: %w", err)
	}
	c.AccessToken = ""
	c.RefreshToken = ""
	c.TokenExpiresAt = time.Time{}
	c.Username = ""
	c.Role = ""
	c.OrgID = ""
	return nil
}

// HasValidToken returns true when a non-empty access token is stored and has
// not yet expired.
func (c *Config) HasValidToken() bool {
	return c.AccessToken != "" && time.Now().Before(c.TokenExpiresAt)
}

// Path returns the filesystem path for the prefs file (config.yaml).
func (c *Config) Path() string {
	return c.configPath
}

// CredentialsPath returns the filesystem path for the credentials file.
func (c *Config) CredentialsPath() string {
	return c.credsPath
}

// SetPath sets the config path explicitly (used when overriding via --config flag).
// The credentials path is derived from the same directory.
func (c *Config) SetPath(p string) {
	c.configPath = p
	c.credsPath = filepath.Join(filepath.Dir(p), credsFileName)
}
