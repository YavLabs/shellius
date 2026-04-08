package cache

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// overrideCacheDir temporarily replaces the home-dir lookup for Dir() by
// setting HOME (or USERPROFILE on Windows) to a temp dir.
func withTempHome(t *testing.T) string {
	t.Helper()
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	return tmp
}

func TestWriteAndReadWithinTTL(t *testing.T) {
	withTempHome(t)

	payload := []byte(`{"hello":"world"}`)
	etag := "etag-v1"

	if err := Write("test.json", payload, etag); err != nil {
		t.Fatalf("Write: %v", err)
	}

	got, gotEtag, ok := Read("test.json", time.Minute)
	if !ok {
		t.Fatal("Read returned ok=false within TTL")
	}
	if string(got) != string(payload) {
		t.Errorf("data = %q, want %q", got, payload)
	}
	if gotEtag != etag {
		t.Errorf("etag = %q, want %q", gotEtag, etag)
	}
}

func TestReadStaleReturnsFalse(t *testing.T) {
	withTempHome(t)

	if err := Write("stale.json", []byte(`{}`), "etag-old"); err != nil {
		t.Fatalf("Write: %v", err)
	}

	// A TTL of 1 nanosecond ensures the entry is already stale.
	_, gotEtag, ok := Read("stale.json", time.Nanosecond)
	if ok {
		t.Error("expected ok=false for stale entry, got true")
	}
	// The ETag should still be returned so callers can send If-None-Match.
	if gotEtag != "etag-old" {
		t.Errorf("expected ETag to be returned for stale entry, got %q", gotEtag)
	}
}

func TestReadMissingReturnsFalse(t *testing.T) {
	withTempHome(t)

	_, _, ok := Read("nonexistent.json", time.Minute)
	if ok {
		t.Error("expected ok=false for missing cache entry")
	}
}

func TestInvalidate(t *testing.T) {
	withTempHome(t)

	if err := Write("inv.json", []byte(`{}`), "e1"); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := Invalidate("inv.json"); err != nil {
		t.Fatalf("Invalidate: %v", err)
	}

	_, _, ok := Read("inv.json", time.Minute)
	if ok {
		t.Error("expected ok=false after Invalidate")
	}

	// Calling Invalidate again on a missing entry must not error.
	if err := Invalidate("inv.json"); err != nil {
		t.Errorf("double Invalidate: %v", err)
	}
}

func TestDirCreatesWithCorrectPerms(t *testing.T) {
	tmp := withTempHome(t)

	d, err := Dir()
	if err != nil {
		t.Fatalf("Dir: %v", err)
	}

	expected := filepath.Join(tmp, ".shellius", "cache")
	if d != expected {
		t.Errorf("Dir = %q, want %q", d, expected)
	}

	fi, err := os.Stat(d)
	if err != nil {
		t.Fatalf("stat cache dir: %v", err)
	}
	if fi.Mode().Perm() != 0700 {
		t.Errorf("cache dir perms = %04o, want 0700", fi.Mode().Perm())
	}
}

func TestFilePermissions(t *testing.T) {
	withTempHome(t)

	if err := Write("perms.json", []byte(`{}`), ""); err != nil {
		t.Fatalf("Write: %v", err)
	}

	dir, _ := Dir()
	for _, name := range []string{"perms.json", "perms.json.meta"} {
		fi, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("stat %s: %v", name, err)
		}
		if fi.Mode().Perm() != 0600 {
			t.Errorf("%s perms = %04o, want 0600", name, fi.Mode().Perm())
		}
	}
}

func TestETag(t *testing.T) {
	withTempHome(t)

	if err := Write("etag.json", []byte(`{}`), "etag-xyz"); err != nil {
		t.Fatalf("Write: %v", err)
	}

	got := ETag("etag.json")
	if got != "etag-xyz" {
		t.Errorf("ETag = %q, want etag-xyz", got)
	}
}

func TestETagMissing(t *testing.T) {
	withTempHome(t)

	got := ETag("missing.json")
	if got != "" {
		t.Errorf("ETag for missing key = %q, want empty", got)
	}
}
