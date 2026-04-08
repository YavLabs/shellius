// Package cache provides a simple JSON file cache with TTL and ETag support
// for the Shellius TUI. Cache files are stored in ~/.shellius/cache/ and each
// entry has a companion .meta sidecar file that records the ETag and timestamp
// so the primary data file remains pristine JSON.
package cache

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const defaultTTL = 15 * time.Minute

// meta is the sidecar file format.
type meta struct {
	ETag      string    `json:"etag"`
	CachedAt  time.Time `json:"cachedAt"`
}

// entry groups a per-key mutex with its associated metadata for in-process
// concurrent safety.
type entry struct {
	mu sync.Mutex
}

var (
	globalMu sync.Mutex
	entries  = make(map[string]*entry)
)

// lockEntry returns (or creates) a per-key lock and acquires it.
// The caller must call the returned unlock func when done.
func lockEntry(name string) func() {
	globalMu.Lock()
	e, ok := entries[name]
	if !ok {
		e = &entry{}
		entries[name] = e
	}
	globalMu.Unlock()
	e.mu.Lock()
	return func() { e.mu.Unlock() }
}

// Dir returns ~/.shellius/cache, creating it with 0700 if it does not exist.
func Dir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cache: home dir: %w", err)
	}
	d := filepath.Join(home, ".shellius", "cache")
	if err := os.MkdirAll(d, 0700); err != nil {
		return "", fmt.Errorf("cache: mkdir: %w", err)
	}
	return d, nil
}

// Read returns the cached bytes and ETag for name if the cache file exists and
// was written within ttl. ok is false when the cache is absent or stale.
// A zero ttl falls back to the 15-minute default.
func Read(name string, ttl time.Duration) (data []byte, etag string, ok bool) {
	if ttl <= 0 {
		ttl = defaultTTL
	}
	unlock := lockEntry(name)
	defer unlock()

	dir, err := Dir()
	if err != nil {
		return nil, "", false
	}

	metaPath := filepath.Join(dir, name+".meta")
	raw, err := os.ReadFile(metaPath)
	if err != nil {
		return nil, "", false
	}
	var m meta
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, "", false
	}

	if time.Since(m.CachedAt) > ttl {
		return nil, m.ETag, false // stale — still return etag for conditional requests
	}

	dataPath := filepath.Join(dir, name)
	bytes, err := os.ReadFile(dataPath)
	if err != nil {
		return nil, m.ETag, false
	}
	return bytes, m.ETag, true
}

// ETag returns just the stored ETag for name without checking TTL.
// Returns an empty string when no metadata is found.
func ETag(name string) string {
	unlock := lockEntry(name)
	defer unlock()

	dir, err := Dir()
	if err != nil {
		return ""
	}
	raw, err := os.ReadFile(filepath.Join(dir, name+".meta"))
	if err != nil {
		return ""
	}
	var m meta
	if err := json.Unmarshal(raw, &m); err != nil {
		return ""
	}
	return m.ETag
}

// Write atomically stores data and etag to the cache dir under name.
// The data file and the .meta sidecar are written independently; a crash
// between them at most leaves a stale data file, which the TTL check handles.
func Write(name string, data []byte, etag string) error {
	unlock := lockEntry(name)
	defer unlock()

	dir, err := Dir()
	if err != nil {
		return err
	}

	dataPath := filepath.Join(dir, name)
	if err := os.WriteFile(dataPath, data, 0600); err != nil {
		return fmt.Errorf("cache: write data: %w", err)
	}

	m := meta{ETag: etag, CachedAt: time.Now()}
	metaBytes, err := json.Marshal(m)
	if err != nil {
		return fmt.Errorf("cache: marshal meta: %w", err)
	}
	metaPath := filepath.Join(dir, name+".meta")
	if err := os.WriteFile(metaPath, metaBytes, 0600); err != nil {
		return fmt.Errorf("cache: write meta: %w", err)
	}
	return nil
}

// Invalidate removes the data and meta files for name, forcing a fresh fetch
// on the next Read. Missing files are not an error.
func Invalidate(name string) error {
	unlock := lockEntry(name)
	defer unlock()

	dir, err := Dir()
	if err != nil {
		return err
	}

	for _, suffix := range []string{"", ".meta"} {
		p := filepath.Join(dir, name+suffix)
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("cache: invalidate %s: %w", p, err)
		}
	}
	return nil
}
