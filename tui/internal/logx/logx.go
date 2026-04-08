// Package logx provides a lightweight, append-only rotating log writer for the
// Shellius TUI. Logs are written to ~/.shellius/shellius.log. When the file
// reaches MaxSize bytes it is truncated to zero (simple rotation — not a ring
// buffer, but sufficient for diagnostics).
package logx

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// MaxSize is the file-size threshold in bytes at which the log is truncated.
const MaxSize = 1 << 20 // 1 MiB

// Logger is a goroutine-safe, append-only, size-capped log writer.
type Logger struct {
	mu   sync.Mutex
	path string
}

// defaultLogger is the package-level singleton, initialised by Init.
var defaultLogger *Logger

// Init creates (or re-uses) the package-level Logger at the given path.
// Subsequent calls to Infof / Warnf use this logger.
func Init(path string) {
	defaultLogger = &Logger{path: path}
}

// DefaultLogPath returns ~/.shellius/shellius.log.
func DefaultLogPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("logx: home dir: %w", err)
	}
	return filepath.Join(home, ".shellius", "shellius.log"), nil
}

// Infof writes an INFO-level line to the default logger (no-op if uninitialised).
func Infof(format string, args ...interface{}) {
	if defaultLogger != nil {
		defaultLogger.write("INFO", fmt.Sprintf(format, args...))
	}
}

// Warnf writes a WARN-level line to the default logger (no-op if uninitialised).
func Warnf(format string, args ...interface{}) {
	if defaultLogger != nil {
		defaultLogger.write("WARN", fmt.Sprintf(format, args...))
	}
}

// Infof writes an INFO-level line via the Logger.
func (l *Logger) Infof(format string, args ...interface{}) {
	l.write("INFO", fmt.Sprintf(format, args...))
}

// Warnf writes a WARN-level line via the Logger.
func (l *Logger) Warnf(format string, args ...interface{}) {
	l.write("WARN", fmt.Sprintf(format, args...))
}

// LastLines returns up to n lines from the end of the log file as a single
// string, suitable for display in the doctor subcommand. Returns an empty string
// if the log does not exist.
func LastLines(path string, n int) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	lines := splitLines(data)
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	result := ""
	for _, l := range lines {
		result += l + "\n"
	}
	return result
}

// splitLines splits a byte slice into non-empty string lines.
func splitLines(data []byte) []string {
	var out []string
	start := 0
	for i, b := range data {
		if b == '\n' {
			if i > start {
				out = append(out, string(data[start:i]))
			}
			start = i + 1
		}
	}
	if start < len(data) {
		out = append(out, string(data[start:]))
	}
	return out
}

// write appends a timestamped log line to the file, rotating if MaxSize is exceeded.
func (l *Logger) write(level, msg string) {
	l.mu.Lock()
	defer l.mu.Unlock()

	if err := os.MkdirAll(filepath.Dir(l.path), 0700); err != nil {
		return
	}

	// Check size and truncate if over limit.
	if fi, err := os.Stat(l.path); err == nil && fi.Size() >= MaxSize {
		// Truncate by re-creating the file.
		if f, err := os.OpenFile(l.path, os.O_TRUNC|os.O_WRONLY, 0600); err == nil {
			f.Close()
		}
	}

	line := fmt.Sprintf("%s [%s] %s\n",
		time.Now().UTC().Format("2006-01-02T15:04:05Z"),
		level,
		msg,
	)

	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(line)
}
