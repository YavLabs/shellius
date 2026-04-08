package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"gopkg.in/yaml.v3"
)

// writeOldConfig writes a monolithic config.yaml in the pre-22g format
// (prefs + tokens in one file).
func writeOldConfig(t *testing.T, dir string, serverURL, accessToken, refreshToken, username string) string {
	t.Helper()
	type oldConfig struct {
		ServerURL      string    `yaml:"serverURL"`
		AccessToken    string    `yaml:"accessToken"`
		RefreshToken   string    `yaml:"refreshToken"`
		TokenExpiresAt time.Time `yaml:"tokenExpiresAt"`
		Username       string    `yaml:"username"`
		Role           string    `yaml:"role"`
		OrgID          string    `yaml:"orgID"`
		OrgSlug        string    `yaml:"orgSlug"`
	}
	cfg := oldConfig{
		ServerURL:      serverURL,
		AccessToken:    accessToken,
		RefreshToken:   refreshToken,
		TokenExpiresAt: time.Now().Add(1 * time.Hour),
		Username:       username,
		Role:           "admin",
		OrgID:          "org-123",
		OrgSlug:        "testorg",
	}
	data, err := yaml.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, data, 0644); err != nil { //nolint:gosec
		t.Fatal(err)
	}
	return path
}

// TestMigrationMovesTokensToCredentials verifies that loading a monolithic
// config.yaml with token fields silently migrates them to the credentials file
// and rewrites config.yaml without those fields.
func TestMigrationMovesTokensToCredentials(t *testing.T) {
	dir := t.TempDir()
	cfgPath := writeOldConfig(t, dir, "http://localhost:3000", "tok-access", "tok-refresh", "alice@example.com")

	cfg, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}

	// Tokens must be accessible via the config.
	if cfg.AccessToken != "tok-access" {
		t.Errorf("AccessToken = %q, want tok-access", cfg.AccessToken)
	}
	if cfg.RefreshToken != "tok-refresh" {
		t.Errorf("RefreshToken = %q, want tok-refresh", cfg.RefreshToken)
	}
	if cfg.Username != "alice@example.com" {
		t.Errorf("Username = %q, want alice@example.com", cfg.Username)
	}
	if cfg.ServerURL != "http://localhost:3000" {
		t.Errorf("ServerURL = %q, want http://localhost:3000", cfg.ServerURL)
	}

	// Credentials file must now exist with mode 0600.
	credsPath := filepath.Join(dir, "credentials")
	fi, err := os.Stat(credsPath)
	if err != nil {
		t.Fatalf("credentials file not created: %v", err)
	}
	if fi.Mode().Perm() != 0600 {
		t.Errorf("credentials perms = %04o, want 0600", fi.Mode().Perm())
	}

	// config.yaml must NOT contain token fields.
	rawCfg, _ := os.ReadFile(cfgPath)
	if contains(rawCfg, "accessToken") {
		t.Error("config.yaml still contains accessToken after migration")
	}
	if contains(rawCfg, "refreshToken") {
		t.Error("config.yaml still contains refreshToken after migration")
	}

	// Migration marker must exist.
	if _, err := os.Stat(filepath.Join(dir, migratedMarker)); err != nil {
		t.Errorf("migration marker not created: %v", err)
	}
}

// TestMigrationIsOneShot verifies the migration marker prevents a second migration.
func TestMigrationIsOneShot(t *testing.T) {
	dir := t.TempDir()
	cfgPath := writeOldConfig(t, dir, "http://localhost:3000", "tok1", "rtok1", "bob@example.com")

	// First load: migration runs.
	if _, err := Load(cfgPath); err != nil {
		t.Fatalf("first Load: %v", err)
	}

	// Corrupt the credentials file to detect if it is re-written.
	credsPath := filepath.Join(dir, "credentials")
	sentinel := []byte("sentinel-content")
	if err := os.WriteFile(credsPath, sentinel, 0600); err != nil {
		t.Fatal(err)
	}

	// Second load: migration must NOT run (marker present).
	if _, err := Load(cfgPath); err != nil {
		// loadCredentials will fail to parse "sentinel-content" as YAML — but
		// it should not re-run the migration.  The parse error here means
		// migration did not re-run (good).
		t.Logf("second Load error (expected if sentinel is invalid YAML): %v", err)
	}

	// Confirm the credentials file still contains the sentinel.
	got, _ := os.ReadFile(credsPath)
	if string(got) != string(sentinel) {
		t.Errorf("credentials file was overwritten by a second migration run: got %q", string(got))
	}
}

// TestStrictCredentialPerms verifies that a credentials file with permissions
// looser than 0600 causes Load to return an error.
func TestStrictCredentialPerms(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	// Write a minimal prefs file (no tokens).
	if err := os.WriteFile(cfgPath, []byte("serverURL: http://localhost:3000\n"), 0644); err != nil { //nolint:gosec
		t.Fatal(err)
	}
	// Write marker so migration does not run.
	if err := os.WriteFile(filepath.Join(dir, migratedMarker), []byte("migrated\n"), 0600); err != nil {
		t.Fatal(err)
	}

	// Write credentials with loose perms.
	credsPath := filepath.Join(dir, "credentials")
	if err := os.WriteFile(credsPath, []byte("accessToken: tok\n"), 0644); err != nil { //nolint:gosec
		t.Fatal(err)
	}

	_, err := Load(cfgPath)
	if err == nil {
		t.Fatal("expected an error for loose credential permissions, got nil")
	}
}

// TestSaveAndClear verifies Save writes both files and Clear removes only credentials.
func TestSaveAndClear(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	cfg := &Config{
		configPath:     cfgPath,
		credsPath:      filepath.Join(dir, "credentials"),
		ServerURL:      "http://example.com",
		AccessToken:    "atok",
		RefreshToken:   "rtok",
		TokenExpiresAt: time.Now().Add(time.Hour),
		Username:       "carol",
	}

	if err := cfg.Save(); err != nil {
		t.Fatalf("Save: %v", err)
	}

	// Both files must exist.
	if _, err := os.Stat(cfgPath); err != nil {
		t.Errorf("config.yaml missing after Save: %v", err)
	}
	if _, err := os.Stat(cfg.credsPath); err != nil {
		t.Errorf("credentials missing after Save: %v", err)
	}

	// config.yaml must be 0644.
	fi, _ := os.Stat(cfgPath)
	if fi.Mode().Perm() != 0644 {
		t.Errorf("config.yaml perms = %04o, want 0644", fi.Mode().Perm())
	}

	// credentials must be 0600.
	fi2, _ := os.Stat(cfg.credsPath)
	if fi2.Mode().Perm() != 0600 {
		t.Errorf("credentials perms = %04o, want 0600", fi2.Mode().Perm())
	}

	// Clear must remove credentials only.
	if err := cfg.Clear(); err != nil {
		t.Fatalf("Clear: %v", err)
	}
	if _, err := os.Stat(cfg.credsPath); !os.IsNotExist(err) {
		t.Error("credentials should not exist after Clear")
	}
	if _, err := os.Stat(cfgPath); err != nil {
		t.Errorf("config.yaml must still exist after Clear: %v", err)
	}
}

// TestLoadMissingFilesReturnsDefaults confirms that missing files are not errors.
func TestLoadMissingFilesReturnsDefaults(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")

	cfg, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("Load with no files: %v", err)
	}
	if cfg.AccessToken != "" || cfg.ServerURL != "" {
		t.Errorf("expected zero values, got AccessToken=%q ServerURL=%q", cfg.AccessToken, cfg.ServerURL)
	}
}

// contains is a helper to check if a byte slice contains a substring.
func contains(data []byte, substr string) bool {
	for i := 0; i <= len(data)-len(substr); i++ {
		if string(data[i:i+len(substr)]) == substr {
			return true
		}
	}
	return false
}
