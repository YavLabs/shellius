package logx

import (
	"os"
	"strings"
	"testing"
)

func TestWriteAndRotate(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "shellius-*.log")
	if err != nil {
		t.Fatal(err)
	}
	path := f.Name()
	f.Close()

	l := &Logger{path: path}

	// Write a message and confirm it appears.
	l.Infof("hello %s", "world")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	if !strings.Contains(string(data), "hello world") {
		t.Errorf("expected log to contain 'hello world', got: %q", string(data))
	}
	if !strings.Contains(string(data), "[INFO]") {
		t.Errorf("expected [INFO] level tag, got: %q", string(data))
	}

	// Fill the file beyond MaxSize and trigger rotation.
	bigMsg := strings.Repeat("x", 1024) // 1 KiB per line
	lines := MaxSize/1024 + 2
	for i := 0; i < lines; i++ {
		l.Warnf("%s", bigMsg)
	}

	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat log after rotation: %v", err)
	}
	// After rotation the file should be smaller than MaxSize.
	if fi.Size() >= MaxSize {
		t.Errorf("expected log to be truncated below MaxSize (%d), got size %d", MaxSize, fi.Size())
	}
}

func TestDefaultLoggerPackageFunctions(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/test.log"
	Init(path)
	Infof("pkg info %d", 42)
	Warnf("pkg warn %s", "oops")

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	if !strings.Contains(string(data), "pkg info 42") {
		t.Errorf("missing info line: %q", string(data))
	}
	if !strings.Contains(string(data), "pkg warn oops") {
		t.Errorf("missing warn line: %q", string(data))
	}
}

func TestLastLines(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/last.log"
	l := &Logger{path: path}
	for i := 0; i < 20; i++ {
		l.Infof("line %d", i)
	}

	result := LastLines(path, 5)
	lines := strings.Split(strings.TrimSpace(result), "\n")
	if len(lines) != 5 {
		t.Errorf("expected 5 lines, got %d: %q", len(lines), result)
	}
	// The last line should be line 19.
	if !strings.Contains(lines[len(lines)-1], "line 19") {
		t.Errorf("last line should be 'line 19', got: %q", lines[len(lines)-1])
	}
}

func TestLastLinesNonexistent(t *testing.T) {
	result := LastLines("/nonexistent/path/shellius.log", 10)
	if result != "" {
		t.Errorf("expected empty string for nonexistent file, got %q", result)
	}
}
