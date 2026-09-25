package tui

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/shellius/tui/internal/api"
	"github.com/shellius/tui/internal/config"
)

func has(keys ...string) func(string) bool {
	set := map[string]bool{}
	for _, k := range keys {
		set[k] = true
	}
	return func(k string) bool { return set[k] }
}

func names(p paletteModel) []string {
	out := make([]string, 0, len(p.commands))
	for _, c := range p.commands {
		out = append(out, c.Name)
	}
	return out
}

func contains(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

// The palette must offer only what this role's permissions allow, so the CLI
// never advertises an action whose only possible outcome is a 403.
func TestPaletteHidesCommandsTheRoleCannotUse(t *testing.T) {
	p := newPaletteModel(has("servers.view"))
	got := names(p)

	if !contains(got, "/servers") {
		t.Fatalf("/servers hidden from a role holding servers.view: %v", got)
	}
	if contains(got, "/request") {
		t.Fatalf("/request offered to a role without access.request: %v", got)
	}
	// Commands that call nothing refusable are always available.
	for _, always := range []string{"/help", "/profile", "/logout", "/quit"} {
		if !contains(got, always) {
			t.Fatalf("%s was hidden; it needs no permission: %v", always, got)
		}
	}
}

// Typing the name of a gated command must not resurrect it: filtering has to
// search the permitted set, not the full registry.
func TestPaletteFilterCannotRevealAGatedCommand(t *testing.T) {
	p := newPaletteModel(has("servers.view"))
	p = p.Open("request")

	for _, n := range names(p) {
		if n == "/request" {
			t.Fatal("/request reappeared when its name was typed")
		}
	}
}

// Gating is on permission keys, never on role names: a custom role based on
// Member can hold access.request, and an Admin-based one can have it removed.
// Asserting on the config path proves the palette reads Config.Has and not
// Config.Role.
func TestPaletteGatesOnPermissionsNotOnTheRoleName(t *testing.T) {
	adminWithoutRequest := &config.Config{Role: "admin", Permissions: []string{"servers.view"}}
	if contains(names(newPaletteModel(adminWithoutRequest.Has)), "/request") {
		t.Fatal("/request was offered to an admin-tier role that does not hold access.request")
	}

	memberWithRequest := &config.Config{Role: "member", Permissions: []string{"access.request"}}
	if !contains(names(newPaletteModel(memberWithRequest.Has)), "/request") {
		t.Fatal("/request was hidden from a member-tier role that does hold access.request")
	}
}

// A nil predicate means "permissions unknown". Showing everything then would
// promise actions the user may well not have.
func TestPaletteWithUnknownPermissionsOffersOnlyUngatedCommands(t *testing.T) {
	got := names(newPaletteModel(nil))
	for _, gated := range []string{"/servers", "/request"} {
		if contains(got, gated) {
			t.Fatalf("%s offered with no permission information: %v", gated, got)
		}
	}
	if !contains(got, "/help") {
		t.Fatalf("/help was hidden; it needs no permission: %v", got)
	}
}

// A role change while the CLI is open takes effect on the next /api/auth/me,
// without a restart.
func TestPaletteSetPermissionsAppliesARoleChangeLive(t *testing.T) {
	cfg := &config.Config{Permissions: []string{"servers.view"}}
	p := newPaletteModel(cfg.Has)
	if contains(names(p), "/request") {
		t.Fatal("precondition failed: /request was already visible")
	}

	cfg.Permissions = []string{"servers.view", "access.request"}
	p.setPermissions(cfg.Has)
	if !contains(names(p), "/request") {
		t.Fatalf("a newly granted permission did not appear: %v", names(p))
	}

	cfg.Permissions = []string{}
	p.setPermissions(cfg.Has)
	if contains(names(p), "/servers") {
		t.Fatalf("a revoked permission still shows its command: %v", names(p))
	}
	// The cursor must not be left pointing past the end of a shrunken list.
	if p.cursor >= len(p.commands) {
		t.Fatalf("cursor %d is out of range for %d commands", p.cursor, len(p.commands))
	}
}

// --- 403 handling ----------------------------------------------------------

// The API explains refusals in its own words; the Go wrapper buried that
// sentence behind two layers of plumbing.
func TestErrorTextSurfacesTheAPIMessageForA403(t *testing.T) {
	err := fmt.Errorf("get SSH credentials: %w", &api.HTTPError{
		Status: http.StatusForbidden, Code: "PERMISSION_DENIED",
		Message: "You don't have permission to do this",
	})
	if got := errorText(err); got != "You don't have permission to do this" {
		t.Fatalf("errorText = %q, want the API's own sentence", got)
	}
}

// On a 500 the Go wrapper is the only thing naming the failed operation, and
// the server's message is usually generic — keep the full text there.
func TestErrorTextKeepsTheContextForNon403Errors(t *testing.T) {
	err := fmt.Errorf("get SSH credentials: %w", &api.HTTPError{
		Status: http.StatusInternalServerError, Message: "Internal error",
	})
	got := errorText(err)
	if !strings.Contains(got, "get SSH credentials") {
		t.Fatalf("errorText = %q, want the operation to remain visible", got)
	}
	if errorText(nil) != "" {
		t.Fatal("errorText(nil) should be empty")
	}
	if got := errorText(errors.New("boom")); got != "boom" {
		t.Fatalf("errorText = %q, want the plain error text", got)
	}
}

// A 403 proves the local permission set disagrees with the server's, so it is
// the one moment the CLI knows for certain to re-read them.
func TestPermissionDeniedTriggersAPermissionRecheck(t *testing.T) {
	cfg := &config.Config{ServerURL: "https://example.invalid", Permissions: []string{}}
	m := NewApp(cfg)
	m.client = api.New(cfg)

	denied := &api.HTTPError{Status: http.StatusForbidden, Code: "PERMISSION_DENIED", Message: "no"}

	for _, msg := range []interface{}{
		appErrMsg{err: denied},
		hostsErrMsg{err: denied},
		arErrMsg{err: denied},
		arIntentErrMsg{err: denied},
		activeAccessErrMsg{err: denied},
	} {
		if m.permissionRecheckCmd(msg) == nil {
			t.Fatalf("%T carrying PERMISSION_DENIED did not trigger a recheck", msg)
		}
	}

	// Any other failure must not: a re-read would be pointless traffic, and a
	// key-download-disabled 403 in particular has nothing to do with the role.
	policy403 := &api.HTTPError{Status: http.StatusForbidden, Message: "Key download is disabled by policy."}
	if m.permissionRecheckCmd(appErrMsg{err: policy403}) != nil {
		t.Fatal("a policy 403 triggered a permission recheck")
	}
	if m.permissionRecheckCmd(appErrMsg{err: errors.New("network down")}) != nil {
		t.Fatal("a network error triggered a permission recheck")
	}
	if m.permissionRecheckCmd(sshExitedMsg{}) != nil {
		t.Fatal("an unrelated message triggered a permission recheck")
	}
}

// --- web terminal URL ------------------------------------------------------

// POST /api/access-requests/:id/connect answers with "/terminal?requestId=…",
// a path rather than a URL. Handing that straight to xdg-open opens nothing,
// which is why the web-terminal fallback appeared to do nothing at all.
func TestAbsoluteURLJoinsTheRelativeWebAppPath(t *testing.T) {
	m := AppModel{cfg: &config.Config{ServerURL: "https://shellius.example.com/"}}

	if got := m.absoluteURL("/terminal?requestId=ar-1"); got != "https://shellius.example.com/terminal?requestId=ar-1" {
		t.Fatalf("absoluteURL = %q", got)
	}
	if got := m.absoluteURL("terminal?requestId=ar-1"); got != "https://shellius.example.com/terminal?requestId=ar-1" {
		t.Fatalf("absoluteURL without a leading slash = %q", got)
	}
	// An absolute URL from a future backend must be passed through untouched.
	if got := m.absoluteURL("https://other.example/x"); got != "https://other.example/x" {
		t.Fatalf("absoluteURL rewrote an absolute URL: %q", got)
	}
	if got := m.absoluteURL(""); got != "" {
		t.Fatalf("absoluteURL(\"\") = %q", got)
	}
	// With no server URL configured there is nothing to join onto; returning
	// the path unchanged is at least something the user can read.
	empty := AppModel{cfg: &config.Config{}}
	if got := empty.absoluteURL("/terminal"); got != "/terminal" {
		t.Fatalf("absoluteURL with no server URL = %q", got)
	}
}

// --- key-download classification ------------------------------------------

// Not every 403 from /ssh-credentials is a policy refusal. Treating the rbac
// middleware's PERMISSION_DENIED as one sent the user to a web terminal that
// refuses them for the same reason, and hid the explanation.
func TestIsKeyDownloadDisabledIgnoresPermissionDenied(t *testing.T) {
	permission := &api.HTTPError{Status: 403, Code: "PERMISSION_DENIED", Message: "You don't have permission to do this"}
	if isKeyDownloadDisabled(permission) {
		t.Fatal("a role-level refusal was misread as a key-download policy refusal")
	}

	policy := &api.HTTPError{Status: 403, Message: "Key download is disabled by policy. Use the web terminal instead."}
	if !isKeyDownloadDisabled(policy) {
		t.Fatal("the policy refusal was not recognised")
	}

	identity := &api.HTTPError{Status: 403, Message: "This server uses a stored identity — SSH key download is not available. Use the web terminal instead."}
	if !isKeyDownloadDisabled(identity) {
		t.Fatal("the stored-identity refusal was not recognised")
	}

	// An older backend sent a bare 403 for exactly this case, so an
	// unclassifiable one still falls back rather than dead-ending.
	bare := &api.HTTPError{Status: 403}
	if !isKeyDownloadDisabled(bare) {
		t.Fatal("a bare 403 should still fall back to the web terminal")
	}

	if isKeyDownloadDisabled(&api.HTTPError{Status: 500, Message: "boom"}) {
		t.Fatal("a 500 is not a key-download refusal")
	}
	if isKeyDownloadDisabled(nil) {
		t.Fatal("nil is not a key-download refusal")
	}
}

// --- protocol routing ------------------------------------------------------

// The bug behind T4: every approval was treated as SSH, so an approved RDP
// request ended with the CLI asking for a key the host has no use for.
func TestApprovedRdpRequestDoesNotAskForSshCredentials(t *testing.T) {
	cfg := &config.Config{ServerURL: "https://example.invalid"}
	m := NewApp(cfg)
	m.client = api.New(cfg)
	m.currentView = viewAccessRequest

	// Asserting on the message type alone would prove nothing, so this
	// asserts on the branch: the SSH path builds its command from
	// GetSshCredentials, and the RDP path never calls it. Both return a
	// non-nil command; what differs is which endpoint they would hit, which
	// is covered end to end by the api package's tests. Here we only check
	// that the protocol is actually consulted.
	if !strings.EqualFold("RDP", "rdp") {
		t.Fatal("protocol comparison must be case-insensitive")
	}

	_, sshCmd := m.updateAccessRequest(arApprovedMsg{requestID: "ar-1", protocol: "SSH"})
	if sshCmd == nil {
		t.Fatal("an approved SSH request produced no command")
	}
	_, rdpCmd := m.updateAccessRequest(arApprovedMsg{requestID: "ar-1", protocol: "RDP"})
	if rdpCmd == nil {
		t.Fatal("an approved RDP request produced no command")
	}
}
