package config

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"gopkg.in/yaml.v3"
)

const configDir = ".shellius"
const configFile = "config.yaml"

// Config holds all persisted TUI configuration.
type Config struct {
	ServerURL      string    `yaml:"serverURL"`
	AccessToken    string    `yaml:"accessToken"`
	RefreshToken   string    `yaml:"refreshToken"`
	TokenExpiresAt time.Time `yaml:"tokenExpiresAt"`
	Username       string    `yaml:"username"`
	Role           string    `yaml:"role"`
	OrgID          string    `yaml:"orgID"`
	OrgSlug        string    `yaml:"orgSlug"`
	configPath     string    `yaml:"-"`
}

// DefaultPath returns ~/.shellius/config.yaml.
func DefaultPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot determine home directory: %w", err)
	}
	return filepath.Join(home, configDir, configFile), nil
}

// Load reads the config from the given path. If the file does not exist a
// zero-value Config is returned (not an error).
func Load(path string) (*Config, error) {
	cfg := &Config{configPath: path}

	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return cfg, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	cfg.configPath = path
	return cfg, nil
}

// Save writes the config to disk. Creates the directory with 0700 if it does
// not exist and writes the file with 0600.
func (c *Config) Save() error {
	dir := filepath.Dir(c.configPath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}

	data, err := yaml.Marshal(c)
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}

	if err := os.WriteFile(c.configPath, data, 0600); err != nil {
		return fmt.Errorf("write config: %w", err)
	}
	return nil
}

// Clear removes tokens and user info, leaving server URL intact.
func (c *Config) Clear() error {
	c.AccessToken = ""
	c.RefreshToken = ""
	c.TokenExpiresAt = time.Time{}
	c.Username = ""
	c.Role = ""
	c.OrgID = ""
	return c.Save()
}

// HasValidToken returns true when a non-empty access token is stored and has
// not yet expired.
func (c *Config) HasValidToken() bool {
	return c.AccessToken != "" && time.Now().Before(c.TokenExpiresAt)
}

// Path returns the filesystem path this config was loaded from / will be saved to.
func (c *Config) Path() string {
	return c.configPath
}

// SetPath sets the config path explicitly (used when overriding via --config flag).
func (c *Config) SetPath(p string) {
	c.configPath = p
}
