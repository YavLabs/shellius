package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shellius/tui/internal/config"
)

// testClient wires a Client at a stub server with credentials that are valid
// for long enough that auth.RefreshIfNeeded is a no-op — these tests are about
// paging, not about token renewal.
func testClient(t *testing.T, h http.Handler) (*Client, func()) {
	t.Helper()
	srv := httptest.NewServer(h)
	cfg := &config.Config{
		ServerURL:      srv.URL,
		AccessToken:    "test-access-token",
		RefreshToken:   "test-refresh-token",
		TokenExpiresAt: time.Now().Add(1 * time.Hour),
		Permissions:    []string{},
	}
	// Give the config a real (throwaway) home so anything that persists —
	// RefreshPermissions writes the new permission set to the credentials
	// file — exercises the same code path it will in production instead of
	// failing on an empty path.
	cfg.SetPath(filepath.Join(t.TempDir(), "config.yaml"))
	c := &Client{BaseURL: srv.URL, HTTPClient: srv.Client(), Config: cfg}
	return c, srv.Close
}

// notIntents short-circuits the decorating /intents call that ListHosts now
// makes after paging. The paging tests below count requests and assert on
// `pageSize`, so without this every one of them would also be measuring a
// call that has nothing to do with paging. Answering with an empty map is
// exactly the "no verdict available" path, which leaves the labels on the
// environment heuristic those tests already assert.
func notIntents(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Path != "/api/access-requests/intents" {
		return true
	}
	writeEnvelope(w, map[string]interface{}{"intents": map[string]interface{}{}})
	return false
}

func writeEnvelope(w http.ResponseWriter, data interface{}) {
	body, err := json.Marshal(map[string]interface{}{"success": true, "data": data})
	if err != nil {
		panic(err)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(body)
}

// serverPage builds one page of GET /api/servers.
func serverPage(items []map[string]interface{}, total, page, pageSize int) map[string]interface{} {
	return map[string]interface{}{
		"items": items, "total": total, "page": page, "pageSize": pageSize,
	}
}

func fakeServers(n int, active bool, idOffset int) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, map[string]interface{}{
			"id":          fmt.Sprintf("srv-%d", idOffset+i),
			"displayName": fmt.Sprintf("host-%d", idOffset+i),
			"hostname":    fmt.Sprintf("h%d.example.com", idOffset+i),
			"port":        22,
			"environment": "dev",
			"sshUser":     "ops",
			"isActive":    active,
			"customer":    map[string]interface{}{"id": "cus-1", "name": "Acme"},
		})
	}
	return out
}

// The bug this whole change exists for: the API returns 25 per page by
// default, so an inventory of 250 was silently truncated to its first 25.
func TestListHostsWalksEveryPage(t *testing.T) {
	const total = 250
	var mu sync.Mutex
	var gotPageSizes []string

	c, done := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !notIntents(w, r) {
			return
		}
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		if page == 0 {
			page = 1
		}
		mu.Lock()
		gotPageSizes = append(gotPageSizes, r.URL.Query().Get("pageSize"))
		mu.Unlock()

		start := (page - 1) * 100
		if start >= total {
			writeEnvelope(w, serverPage(nil, total, page, 100))
			return
		}
		n := 100
		if start+n > total {
			n = total - start
		}
		writeEnvelope(w, serverPage(fakeServers(n, true, start), total, page, 100))
	}))
	defer done()

	hosts, err := c.ListHosts()
	if err != nil {
		t.Fatalf("ListHosts: %v", err)
	}
	if len(hosts) != total {
		t.Fatalf("got %d hosts, want %d", len(hosts), total)
	}
	// It must ask for the maximum page size, not accept the default of 25.
	for _, ps := range gotPageSizes {
		if ps != "100" {
			t.Fatalf("requested pageSize %q, want 100", ps)
		}
	}
	// 250 rows at 100 per page is exactly 3 requests; a fourth would mean the
	// short-page stop did not fire.
	if len(gotPageSizes) != 3 {
		t.Fatalf("made %d requests, want 3", len(gotPageSizes))
	}
}

// Inactive hosts are filtered out of the result but still counted by the
// server's `total`. Tracking progress by rows returned rather than rows seen
// would page to the cap whenever the tail of an inventory was deactivated.
func TestListHostsCountsInactiveTowardsProgress(t *testing.T) {
	const total = 150
	var mu sync.Mutex
	requests := 0

	c, done := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !notIntents(w, r) {
			return
		}
		mu.Lock()
		requests++
		mu.Unlock()
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		switch page {
		case 1:
			writeEnvelope(w, serverPage(fakeServers(100, true, 0), total, 1, 100))
		case 2:
			// Every row on the last page is deactivated.
			writeEnvelope(w, serverPage(fakeServers(50, false, 100), total, 2, 100))
		default:
			writeEnvelope(w, serverPage(nil, total, page, 100))
		}
	}))
	defer done()

	hosts, err := c.ListHosts()
	if err != nil {
		t.Fatalf("ListHosts: %v", err)
	}
	if len(hosts) != 100 {
		t.Fatalf("got %d active hosts, want 100", len(hosts))
	}
	if requests != 2 {
		t.Fatalf("made %d requests, want 2 (it must stop on total, not on rows kept)", requests)
	}
}

// A backend that always returns the same rows must not be paged for ever.
func TestListHostsStopsWhenAPageIsAllDuplicates(t *testing.T) {
	var mu sync.Mutex
	requests := 0

	c, done := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !notIntents(w, r) {
			return
		}
		mu.Lock()
		requests++
		mu.Unlock()
		// Ignores `page` entirely and claims there is much more to come.
		writeEnvelope(w, serverPage(fakeServers(100, true, 0), 100000, 1, 100))
	}))
	defer done()

	hosts, err := c.ListHosts()
	if err != nil {
		t.Fatalf("ListHosts: %v", err)
	}
	if len(hosts) != 100 {
		t.Fatalf("got %d hosts, want 100 deduped", len(hosts))
	}
	if requests != 2 {
		t.Fatalf("made %d requests, want 2 (page 2 is all duplicates and must stop it)", requests)
	}
}

// Deduping is not only a safety net: offset paging over a list ordered by
// creation date genuinely repeats rows when something is inserted mid-walk.
func TestListHostsDedupesOverlappingPages(t *testing.T) {
	c, done := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !notIntents(w, r) {
			return
		}
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		switch page {
		case 1:
			writeEnvelope(w, serverPage(fakeServers(100, true, 0), 150, 1, 100))
		case 2:
			// Rows 90-139: the last ten of page 1 shifted down by an insert.
			writeEnvelope(w, serverPage(fakeServers(50, true, 90), 150, 2, 100))
		default:
			writeEnvelope(w, serverPage(nil, 150, page, 100))
		}
	}))
	defer done()

	hosts, err := c.ListHosts()
	if err != nil {
		t.Fatalf("ListHosts: %v", err)
	}
	if len(hosts) != 140 {
		t.Fatalf("got %d hosts, want 140 unique", len(hosts))
	}
	seen := map[string]bool{}
	for _, h := range hosts {
		if seen[h.ID] {
			t.Fatalf("duplicate host %s in result", h.ID)
		}
		seen[h.ID] = true
	}
}

// A backend that reports no total at all must still terminate, on a short page.
func TestListHostsStopsOnShortPageWithoutTotal(t *testing.T) {
	c, done := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !notIntents(w, r) {
			return
		}
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		if page == 1 {
			writeEnvelope(w, map[string]interface{}{"items": fakeServers(100, true, 0)})
			return
		}
		writeEnvelope(w, map[string]interface{}{"items": fakeServers(7, true, 100)})
	}))
	defer done()

	hosts, err := c.ListHosts()
	if err != nil {
		t.Fatalf("ListHosts: %v", err)
	}
	if len(hosts) != 107 {
		t.Fatalf("got %d hosts, want 107", len(hosts))
	}
}

// The server silently caps pageSize at 100. If it ever capped lower, the stop
// condition must compare against the size it actually used.
func TestListHostsHonoursServerReportedPageSize(t *testing.T) {
	c, done := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !notIntents(w, r) {
			return
		}
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		if page == 1 {
			// Asked for 100, served 25, and says so.
			writeEnvelope(w, map[string]interface{}{
				"items": fakeServers(25, true, 0), "page": 1, "pageSize": 25,
			})
			return
		}
		writeEnvelope(w, map[string]interface{}{
			"items": fakeServers(10, true, 25), "page": 2, "pageSize": 25,
		})
	}))
	defer done()

	hosts, err := c.ListHosts()
	if err != nil {
		t.Fatalf("ListHosts: %v", err)
	}
	if len(hosts) != 35 {
		t.Fatalf("got %d hosts, want 35 (a full 25-row page is not the last page)", len(hosts))
	}
}

func TestListHostsPropagatesErrors(t *testing.T) {
	c, done := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": false,
			"error":   map[string]string{"code": "PERMISSION_DENIED", "message": "nope"},
		})
	}))
	defer done()

	if _, err := c.ListHosts(); err == nil {
		t.Fatal("expected an error, got nil")
	}
}

// A page 2 failure must not be swallowed into a partial list presented as
// complete — a half inventory looks exactly like a small one.
func TestListHostsFailsRatherThanReturningAPartialList(t *testing.T) {
	c, done := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !notIntents(w, r) {
			return
		}
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		if page == 1 {
			writeEnvelope(w, serverPage(fakeServers(100, true, 0), 250, 1, 100))
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": false, "error": map[string]string{"message": "boom"},
		})
	}))
	defer done()

	hosts, err := c.ListHosts()
	if err == nil {
		t.Fatalf("expected an error, got %d hosts", len(hosts))
	}
	if hosts != nil {
		t.Fatalf("expected no hosts alongside the error, got %d", len(hosts))
	}
}

func TestListHostsMarksProdAsRequiringApproval(t *testing.T) {
	c, done := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !notIntents(w, r) {
			return
		}
		items := fakeServers(1, true, 0)
		items[0]["environment"] = "prod"
		items[0]["port"] = 0 // exercises the default-port fallback
		writeEnvelope(w, serverPage(items, 1, 1, 100))
	}))
	defer done()

	hosts, err := c.ListHosts()
	if err != nil {
		t.Fatalf("ListHosts: %v", err)
	}
	if len(hosts) != 1 {
		t.Fatalf("got %d hosts, want 1", len(hosts))
	}
	if hosts[0].AccessStatus != "requires_approval" {
		t.Fatalf("prod host access status = %q, want requires_approval", hosts[0].AccessStatus)
	}
	if hosts[0].Port != 22 {
		t.Fatalf("port = %d, want the 22 fallback", hosts[0].Port)
	}

	c.Config.Permissions = []string{"access.prod_bypass"}
	hosts, err = c.ListHosts()
	if err != nil {
		t.Fatalf("ListHosts: %v", err)
	}
	if hosts[0].AccessStatus != "direct" {
		t.Fatalf("with prod_bypass, access status = %q, want direct", hosts[0].AccessStatus)
	}
}

// --- access requests -------------------------------------------------------

func fakeRequests(n int, status string, idOffset int) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, map[string]interface{}{
			"id": fmt.Sprintf("req-%d", idOffset+i), "status": status,
			"serverId": "srv-1", "createdAt": time.Now().Format(time.RFC3339),
		})
	}
	return out
}

func TestListMyAccessRequestsWalksEveryPage(t *testing.T) {
	var mu sync.Mutex
	var limits []string

	c, done := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		limits = append(limits, r.URL.Query().Get("limit"))
		mu.Unlock()
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		switch page {
		case 1:
			writeEnvelope(w, map[string]interface{}{"items": fakeRequests(100, "PENDING", 0), "total": 130})
		case 2:
			writeEnvelope(w, map[string]interface{}{"items": fakeRequests(30, "PENDING", 100), "total": 130})
		default:
			writeEnvelope(w, map[string]interface{}{"items": []interface{}{}, "total": 130})
		}
	}))
	defer done()

	reqs, err := c.ListMyAccessRequests()
	if err != nil {
		t.Fatalf("ListMyAccessRequests: %v", err)
	}
	if len(reqs) != 130 {
		t.Fatalf("got %d requests, want 130", len(reqs))
	}
	for _, l := range limits {
		if l != "100" {
			t.Fatalf("requested limit %q, want 100 (the endpoint's maximum)", l)
		}
	}
}

// A bare array carries no total and no page size. Paging it is not possible,
// and asking for page 2 would most likely re-serve the same rows for ever.
func TestListMyAccessRequestsStopsOnBareArrayResponse(t *testing.T) {
	var mu sync.Mutex
	requests := 0

	c, done := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests++
		mu.Unlock()
		writeEnvelope(w, fakeRequests(100, "PENDING", 0))
	}))
	defer done()

	reqs, err := c.ListMyAccessRequests()
	if err != nil {
		t.Fatalf("ListMyAccessRequests: %v", err)
	}
	if len(reqs) != 100 {
		t.Fatalf("got %d requests, want 100", len(reqs))
	}
	if requests != 1 {
		t.Fatalf("made %d requests, want 1 — an unpageable response must be taken once", requests)
	}
}

// The older `accessRequests` envelope key must keep working.
func TestListMyAccessRequestsAcceptsLegacyEnvelopeKey(t *testing.T) {
	c, done := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !notIntents(w, r) {
			return
		}
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		if page == 1 {
			writeEnvelope(w, map[string]interface{}{
				"accessRequests": fakeRequests(3, "PENDING", 0), "total": 3,
			})
			return
		}
		writeEnvelope(w, map[string]interface{}{"accessRequests": []interface{}{}, "total": 3})
	}))
	defer done()

	reqs, err := c.ListMyAccessRequests()
	if err != nil {
		t.Fatalf("ListMyAccessRequests: %v", err)
	}
	if len(reqs) != 3 {
		t.Fatalf("got %d requests, want 3", len(reqs))
	}
}

// Paging must not disturb the expiry filter the active list applies.
func TestListMyActiveAccessRequestsFiltersExpiredAcrossPages(t *testing.T) {
	past := time.Now().Add(-time.Hour).Format(time.RFC3339)
	future := time.Now().Add(time.Hour).Format(time.RFC3339)

	c, done := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !notIntents(w, r) {
			return
		}
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		if page == 1 {
			items := fakeRequests(100, "APPROVED", 0)
			for i := range items {
				if i%2 == 0 {
					items[i]["expiresAt"] = past
				} else {
					items[i]["expiresAt"] = future
				}
			}
			writeEnvelope(w, map[string]interface{}{"items": items, "total": 102})
			return
		}
		items := fakeRequests(2, "APPROVED", 100)
		items[0]["expiresAt"] = future
		items[1]["status"] = "DENIED"
		items[1]["expiresAt"] = future
		writeEnvelope(w, map[string]interface{}{"items": items, "total": 102})
	}))
	defer done()

	reqs, err := c.ListMyActiveAccessRequests()
	if err != nil {
		t.Fatalf("ListMyActiveAccessRequests: %v", err)
	}
	// 50 unexpired from page 1, plus the one unexpired APPROVED row on page 2.
	if len(reqs) != 51 {
		t.Fatalf("got %d active requests, want 51", len(reqs))
	}
}

// The filter must survive being combined with the paging parameters.
func TestListAccessRequestsPreservesTheCallerQuery(t *testing.T) {
	var mu sync.Mutex
	var gotTab, gotStatus string

	c, done := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		gotTab = r.URL.Query().Get("tab")
		gotStatus = r.URL.Query().Get("status")
		mu.Unlock()
		writeEnvelope(w, map[string]interface{}{"items": []interface{}{}, "total": 0})
	}))
	defer done()

	if _, err := c.ListMyActiveAccessRequests(); err != nil {
		t.Fatalf("ListMyActiveAccessRequests: %v", err)
	}
	if gotTab != "mine" || gotStatus != "APPROVED" {
		t.Fatalf("query lost: tab=%q status=%q", gotTab, gotStatus)
	}
}

// --- T2: permissions are re-read from the server ---------------------------

// meHandler serves GET /api/auth/me with the given user object.
func meHandler(t *testing.T, user map[string]interface{}) http.Handler {
	t.Helper()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/auth/me" {
			t.Errorf("unexpected request path %q, want /api/auth/me", r.URL.Path)
		}
		if r.Method != "GET" {
			t.Errorf("unexpected method %q, want GET", r.Method)
		}
		writeEnvelope(w, map[string]interface{}{"user": user})
	})
}

// The bug: permissions were captured once at sign-in and a token refresh
// never returns them, so a role change was invisible until the user signed
// out and back in.
func TestRefreshPermissionsReplacesTheStoredSet(t *testing.T) {
	c, done := testClient(t, meHandler(t, map[string]interface{}{
		"id":          "u1",
		"email":       "someone@example.com",
		"role":        "manager",
		"permissions": []string{"access.request", "servers.view"},
		"orgId":       "org-1",
		"roleInfo": map[string]interface{}{
			"id": "r1", "key": "oncall", "name": "On-call", "baseRole": "manager",
		},
		"organization": map[string]interface{}{"id": "org-1", "slug": "acme"},
	}))
	defer done()

	c.Config.Permissions = []string{"servers.view"}
	c.Config.Role = "member"

	changed, err := c.RefreshPermissions()
	if err != nil {
		t.Fatalf("RefreshPermissions: %v", err)
	}
	if !changed {
		t.Fatal("changed = false, want true — the permission set differs from the stored one")
	}
	if !c.Config.Has("access.request") {
		t.Fatal("the newly granted access.request permission was not applied")
	}
	if c.Config.Role != "manager" {
		t.Fatalf("role = %q, want manager", c.Config.Role)
	}
	if c.Config.RoleName != "On-call" {
		t.Fatalf("roleName = %q, want the custom role's display name", c.Config.RoleName)
	}
	if c.Config.OrgSlug != "acme" {
		t.Fatalf("orgSlug = %q, want acme", c.Config.OrgSlug)
	}
	if c.Config.Username != "someone@example.com" {
		t.Fatalf("username = %q, want the email from /me", c.Config.Username)
	}
}

// The refresh has to survive a restart, or the next launch resurrects the
// stale set from the credentials file and the fix lasts one session.
func TestRefreshPermissionsPersistsToTheCredentialsFile(t *testing.T) {
	c, done := testClient(t, meHandler(t, map[string]interface{}{
		"id": "u1", "email": "a@b.c", "role": "member",
		"permissions": []string{"access.request"},
	}))
	defer done()

	if _, err := c.RefreshPermissions(); err != nil {
		t.Fatalf("RefreshPermissions: %v", err)
	}

	reloaded, err := config.Load(c.Config.Path())
	if err != nil {
		t.Fatalf("reload config: %v", err)
	}
	if !reloaded.Has("access.request") {
		t.Fatalf("permissions were not persisted; reloaded set = %v", reloaded.Permissions)
	}
}

// A user stripped of every permission must end up with an empty-but-non-nil
// list. A nil list makes config.Has fall back to the legacy "admin tier
// implies prod_bypass" guess, silently handing back what was just revoked.
func TestRefreshPermissionsWithNoPermissionsDoesNotFallBackToRoleDefaults(t *testing.T) {
	c, done := testClient(t, meHandler(t, map[string]interface{}{
		"id": "u1", "email": "a@b.c", "role": "admin",
		"permissions": []string{},
	}))
	defer done()

	c.Config.Permissions = []string{"access.prod_bypass"}

	if _, err := c.RefreshPermissions(); err != nil {
		t.Fatalf("RefreshPermissions: %v", err)
	}
	if c.Config.Permissions == nil {
		t.Fatal("permissions are nil — config.Has would fall back to role defaults")
	}
	if c.Config.Has("access.prod_bypass") {
		t.Fatal("a revoked permission is still reported as held")
	}
}

// Losing a custom role must clear its display name, or the profile screen
// keeps naming a role the user no longer holds.
func TestRefreshPermissionsClearsAStaleRoleName(t *testing.T) {
	c, done := testClient(t, meHandler(t, map[string]interface{}{
		"id": "u1", "email": "a@b.c", "role": "member",
		"permissions": []string{}, "roleInfo": nil,
	}))
	defer done()

	c.Config.RoleName = "On-call"
	if _, err := c.RefreshPermissions(); err != nil {
		t.Fatalf("RefreshPermissions: %v", err)
	}
	if c.Config.RoleName != "" {
		t.Fatalf("roleName = %q, want it cleared", c.Config.RoleName)
	}
}

// "changed" drives a user-visible toast, so it must not fire merely because
// the server serialised the same permissions in a different order.
func TestRefreshPermissionsIgnoresOrdering(t *testing.T) {
	c, done := testClient(t, meHandler(t, map[string]interface{}{
		"id": "u1", "email": "a@b.c", "role": "member",
		"permissions": []string{"servers.view", "access.request"},
	}))
	defer done()

	c.Config.Permissions = []string{"access.request", "servers.view"}
	c.Config.Role = "member"

	changed, err := c.RefreshPermissions()
	if err != nil {
		t.Fatalf("RefreshPermissions: %v", err)
	}
	if changed {
		t.Fatal("changed = true for the same set in a different order")
	}
}

// A failed refresh must leave the stored set alone rather than blanking it —
// an offline CLI with no permissions can do nothing at all.
func TestRefreshPermissionsLeavesTheStoredSetOnFailure(t *testing.T) {
	c, done := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": false, "error": map[string]string{"message": "boom"},
		})
	}))
	defer done()

	c.Config.Permissions = []string{"access.request"}
	if _, err := c.RefreshPermissions(); err == nil {
		t.Fatal("expected an error, got nil")
	}
	if !c.Config.Has("access.request") {
		t.Fatal("a failed refresh wiped the stored permissions")
	}
}

func TestIsPermissionDeniedOnlyMatchesTheRbacRefusal(t *testing.T) {
	denied := &HTTPError{Status: 403, Code: "PERMISSION_DENIED", Message: "You don't have permission to do this"}
	if !IsPermissionDenied(denied) {
		t.Fatal("the rbac middleware's own 403 was not recognised")
	}
	// The key-download-disabled refusal is also a 403 but is NOT a permission
	// problem; re-reading permissions for it would be pointless, and treating
	// it as one would send the user down the wrong recovery path.
	policy := &HTTPError{Status: 403, Message: "Key download is disabled by policy."}
	if IsPermissionDenied(policy) {
		t.Fatal("a policy 403 was misread as a permission refusal")
	}
	if IsPermissionDenied(fmt.Errorf("wrapped: %w", denied)) != true {
		t.Fatal("a wrapped permission refusal was not recognised")
	}
	if IsPermissionDenied(nil) {
		t.Fatal("nil is not a permission refusal")
	}
}

func TestMessagePrefersTheAPIsOwnWords(t *testing.T) {
	err := fmt.Errorf("get SSH credentials: %w",
		&HTTPError{Status: 403, Code: "PERMISSION_DENIED", Message: "Your role doesn't include access.request"})
	if got := Message(err); got != "Your role doesn't include access.request" {
		t.Fatalf("Message = %q, want the API's sentence", got)
	}
	plain := fmt.Errorf("network unreachable")
	if got := Message(plain); got != "network unreachable" {
		t.Fatalf("Message = %q, want the error text for a non-API error", got)
	}
}

// --- T3: access status comes from the policy, not from the environment -----

// intentEntry builds one /intents row as the current backend sends it.
func intentEntry(active, pending, allowed, requiresApproval, isProd bool, expiresAt string) map[string]interface{} {
	e := map[string]interface{}{
		"hasActiveAccess": active, "activeRequestId": nil,
		"hasPendingRequest": pending, "pendingRequestId": nil,
		"expiresAt":        nil,
		"allowed":          allowed,
		"requiresApproval": requiresApproval,
		"isProduction":     isProd,
		"reason":           "test",
	}
	if expiresAt != "" {
		e["expiresAt"] = expiresAt
	}
	return e
}

// listAndIntents serves one page of servers plus an /intents map, recording
// every serverIds batch it was asked for.
func listAndIntents(t *testing.T, items []map[string]interface{}, intents map[string]interface{}, batches *[][]string, mu *sync.Mutex, intentStatus int) http.Handler {
	t.Helper()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/api/servers"):
			writeEnvelope(w, serverPage(items, len(items), 1, 100))
		case r.URL.Path == "/api/access-requests/intents":
			ids := strings.Split(r.URL.Query().Get("serverIds"), ",")
			mu.Lock()
			*batches = append(*batches, ids)
			mu.Unlock()
			if intentStatus != 0 && intentStatus != 200 {
				w.WriteHeader(intentStatus)
				json.NewEncoder(w).Encode(map[string]interface{}{
					"success": false, "error": map[string]string{"message": "not found"},
				})
				return
			}
			out := map[string]interface{}{}
			for _, id := range ids {
				if v, ok := intents[id]; ok {
					out[id] = v
				}
			}
			writeEnvelope(w, map[string]interface{}{"intents": out})
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	})
}

// The whole point of T3: a non-prod server can still be unreachable or gated,
// and the old "prod = approval, everything else = direct" guess said "direct"
// for every one of them.
func TestListHostsLabelsNonProdFromThePolicyVerdict(t *testing.T) {
	items := fakeServers(3, true, 0)
	items[0]["environment"] = "dev"     // allowed, no approval
	items[1]["environment"] = "staging" // allowed, approval required
	items[2]["environment"] = "dev"     // DENY policy / no matching policy

	intents := map[string]interface{}{
		"srv-0": intentEntry(false, false, true, false, false, ""),
		"srv-1": intentEntry(false, false, true, true, false, ""),
		"srv-2": intentEntry(false, false, false, false, false, ""),
	}

	var mu sync.Mutex
	var batches [][]string
	c, done := testClient(t, listAndIntents(t, items, intents, &batches, &mu, 200))
	defer done()

	hosts, err := c.ListHosts()
	if err != nil {
		t.Fatalf("ListHosts: %v", err)
	}
	byID := map[string]Host{}
	for _, h := range hosts {
		byID[h.ID] = h
	}
	if got := byID["srv-0"].AccessStatus; got != AccessDirect {
		t.Fatalf("srv-0 = %q, want direct", got)
	}
	if got := byID["srv-1"].AccessStatus; got != AccessRequiresApproval {
		t.Fatalf("srv-1 = %q, want requires_approval — a non-prod policy can require it too", got)
	}
	if got := byID["srv-2"].AccessStatus; got != AccessNone {
		t.Fatalf("srv-2 = %q, want no_access — this is the row the old heuristic called 'direct'", got)
	}
}

// An existing grant outranks any policy verdict: it is a decision already made.
func TestListHostsPrefersActiveAndPendingOverThePolicyVerdict(t *testing.T) {
	expiry := time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339)
	items := fakeServers(2, true, 0)
	items[0]["environment"] = "prod"
	items[1]["environment"] = "prod"

	intents := map[string]interface{}{
		"srv-0": intentEntry(true, false, true, true, true, expiry),
		"srv-1": intentEntry(false, true, true, true, true, ""),
	}

	var mu sync.Mutex
	var batches [][]string
	c, done := testClient(t, listAndIntents(t, items, intents, &batches, &mu, 200))
	defer done()

	hosts, err := c.ListHosts()
	if err != nil {
		t.Fatalf("ListHosts: %v", err)
	}
	byID := map[string]Host{}
	for _, h := range hosts {
		byID[h.ID] = h
	}
	if byID["srv-0"].AccessStatus != AccessActive {
		t.Fatalf("srv-0 = %q, want active", byID["srv-0"].AccessStatus)
	}
	if byID["srv-0"].AccessExpiry == nil {
		t.Fatal("srv-0 has active access but no expiry to count down")
	}
	if byID["srv-1"].AccessStatus != AccessPending {
		t.Fatalf("srv-1 = %q, want pending", byID["srv-1"].AccessStatus)
	}
}

// The degradation that matters most: the host list is the main screen, and it
// must survive the intents endpoint being missing, broken, or forbidden.
func TestListHostsSurvivesTheIntentsEndpointFailing(t *testing.T) {
	items := fakeServers(2, true, 0)
	items[0]["environment"] = "prod"
	items[1]["environment"] = "dev"

	for _, status := range []int{http.StatusNotFound, http.StatusInternalServerError, http.StatusForbidden} {
		var mu sync.Mutex
		var batches [][]string
		c, done := testClient(t, listAndIntents(t, items, nil, &batches, &mu, status))

		hosts, err := c.ListHosts()
		if err != nil {
			done()
			t.Fatalf("intents HTTP %d made the whole host list fail: %v", status, err)
		}
		if len(hosts) != 2 {
			done()
			t.Fatalf("intents HTTP %d: got %d hosts, want 2", status, len(hosts))
		}
		byID := map[string]Host{}
		for _, h := range hosts {
			byID[h.ID] = h
		}
		// Straight back to the prod-only heuristic.
		if byID["srv-0"].AccessStatus != AccessRequiresApproval {
			done()
			t.Fatalf("intents HTTP %d: prod host = %q, want the requires_approval fallback",
				status, byID["srv-0"].AccessStatus)
		}
		if byID["srv-1"].AccessStatus != AccessDirect {
			done()
			t.Fatalf("intents HTTP %d: dev host = %q, want the direct fallback",
				status, byID["srv-1"].AccessStatus)
		}
		done()
	}
}

// A server can be deleted between the list call and the intents call.
func TestListHostsKeepsTheHeuristicForAServerMissingFromTheIntents(t *testing.T) {
	items := fakeServers(2, true, 0)
	items[0]["environment"] = "dev"
	items[1]["environment"] = "prod"
	intents := map[string]interface{}{
		"srv-0": intentEntry(false, false, false, false, false, ""),
		// srv-1 deliberately absent.
	}

	var mu sync.Mutex
	var batches [][]string
	c, done := testClient(t, listAndIntents(t, items, intents, &batches, &mu, 200))
	defer done()

	hosts, err := c.ListHosts()
	if err != nil {
		t.Fatalf("ListHosts: %v", err)
	}
	byID := map[string]Host{}
	for _, h := range hosts {
		byID[h.ID] = h
	}
	if byID["srv-0"].AccessStatus != AccessNone {
		t.Fatalf("srv-0 = %q, want no_access", byID["srv-0"].AccessStatus)
	}
	if byID["srv-1"].AccessStatus != AccessRequiresApproval {
		t.Fatalf("srv-1 = %q, want the prod heuristic to stand", byID["srv-1"].AccessStatus)
	}
}

// An older Shellius answers /intents without the policy fields. Reading the
// missing `allowed` as Go's zero value would grey out an entire inventory.
func TestListHostsDoesNotInventAVerdictFromAnOlderBackend(t *testing.T) {
	items := fakeServers(2, true, 0)
	items[0]["environment"] = "dev"
	items[1]["environment"] = "dev"
	intents := map[string]interface{}{
		"srv-0": map[string]interface{}{
			"hasActiveAccess": false, "activeRequestId": nil,
			"hasPendingRequest": false, "pendingRequestId": nil, "expiresAt": nil,
		},
		"srv-1": map[string]interface{}{
			"hasActiveAccess": false, "activeRequestId": nil,
			"hasPendingRequest": true, "pendingRequestId": "ar-9", "expiresAt": nil,
		},
	}

	var mu sync.Mutex
	var batches [][]string
	c, done := testClient(t, listAndIntents(t, items, intents, &batches, &mu, 200))
	defer done()

	hosts, err := c.ListHosts()
	if err != nil {
		t.Fatalf("ListHosts: %v", err)
	}
	byID := map[string]Host{}
	for _, h := range hosts {
		byID[h.ID] = h
	}
	if byID["srv-0"].AccessStatus != AccessDirect {
		t.Fatalf("srv-0 = %q, want the heuristic's direct — not a fabricated no_access",
			byID["srv-0"].AccessStatus)
	}
	// The half of the answer an older backend DOES give is still worth using.
	if byID["srv-1"].AccessStatus != AccessPending {
		t.Fatalf("srv-1 = %q, want pending", byID["srv-1"].AccessStatus)
	}
}

// The route rejects the whole call at serverIds.length > 50, so an inventory
// larger than that has to be split or none of it gets labelled.
func TestGetAccessIntentsBatchesAtTheRoutesCap(t *testing.T) {
	const total = 125
	items := fakeServers(total, true, 0)
	intents := map[string]interface{}{}
	for i := 0; i < total; i++ {
		intents[fmt.Sprintf("srv-%d", i)] = intentEntry(false, false, true, true, false, "")
	}

	var mu sync.Mutex
	var batches [][]string
	c, done := testClient(t, listAndIntents(t, items, intents, &batches, &mu, 200))
	defer done()

	hosts, err := c.ListHosts()
	if err != nil {
		t.Fatalf("ListHosts: %v", err)
	}
	if len(batches) != 3 {
		t.Fatalf("made %d intents requests, want 3 (50+50+25)", len(batches))
	}
	for i, b := range batches {
		if len(b) > 50 {
			t.Fatalf("batch %d carried %d ids; the route refuses more than 50", i, len(b))
		}
	}
	for _, h := range hosts {
		if h.AccessStatus != AccessRequiresApproval {
			t.Fatalf("%s = %q, want every row labelled from its verdict", h.ID, h.AccessStatus)
		}
	}
}

// A batch failing halfway must not discard the batches that succeeded.
func TestGetAccessIntentsReturnsPartialResultsAlongsideTheError(t *testing.T) {
	c, done := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ids := strings.Split(r.URL.Query().Get("serverIds"), ",")
		if ids[0] != "srv-0" {
			// Everything after the first batch fails.
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"success": false, "error": map[string]string{"message": "boom"},
			})
			return
		}
		out := map[string]interface{}{}
		for _, id := range ids {
			out[id] = intentEntry(false, false, true, false, false, "")
		}
		writeEnvelope(w, map[string]interface{}{"intents": out})
	}))
	defer done()

	ids := make([]string, 0, 75)
	for i := 0; i < 75; i++ {
		ids = append(ids, fmt.Sprintf("srv-%d", i))
	}
	got, err := c.GetAccessIntents(ids)
	if err == nil {
		t.Fatal("expected the second batch's error to be reported")
	}
	if len(got) != 50 {
		t.Fatalf("got %d intents, want the 50 from the batch that succeeded", len(got))
	}
}

// An empty inventory must not produce a request at all: /intents answers an
// empty serverIds with HTTP 400.
func TestGetAccessIntentsMakesNoRequestForAnEmptyList(t *testing.T) {
	var mu sync.Mutex
	requests := 0
	c, done := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests++
		mu.Unlock()
		writeEnvelope(w, map[string]interface{}{"intents": map[string]interface{}{}})
	}))
	defer done()

	got, err := c.GetAccessIntents(nil)
	if err != nil {
		t.Fatalf("GetAccessIntents(nil): %v", err)
	}
	if len(got) != 0 || requests != 0 {
		t.Fatalf("got %d intents in %d requests, want 0 and 0", len(got), requests)
	}
	if _, err := c.GetAccessIntents([]string{"", ""}); err != nil {
		t.Fatalf("GetAccessIntents of blank ids: %v", err)
	}
	if requests != 0 {
		t.Fatalf("blank ids still produced %d requests", requests)
	}
}

// An empty inventory must not produce an intents call from ListHosts either.
func TestListHostsSkipsIntentsForAnEmptyInventory(t *testing.T) {
	var mu sync.Mutex
	intentCalls := 0
	c, done := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/access-requests/intents" {
			mu.Lock()
			intentCalls++
			mu.Unlock()
		}
		writeEnvelope(w, serverPage(nil, 0, 1, 100))
	}))
	defer done()

	hosts, err := c.ListHosts()
	if err != nil {
		t.Fatalf("ListHosts: %v", err)
	}
	if len(hosts) != 0 || intentCalls != 0 {
		t.Fatalf("got %d hosts and %d intents calls, want 0 and 0", len(hosts), intentCalls)
	}
}

func TestGetAccessIntentsDedupesIds(t *testing.T) {
	var mu sync.Mutex
	var seenIDs []string
	c, done := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ids := strings.Split(r.URL.Query().Get("serverIds"), ",")
		mu.Lock()
		seenIDs = append(seenIDs, ids...)
		mu.Unlock()
		writeEnvelope(w, map[string]interface{}{"intents": map[string]interface{}{}})
	}))
	defer done()

	if _, err := c.GetAccessIntents([]string{"a", "b", "a", "b", "a"}); err != nil {
		t.Fatalf("GetAccessIntents: %v", err)
	}
	sort.Strings(seenIDs)
	if len(seenIDs) != 2 || seenIDs[0] != "a" || seenIDs[1] != "b" {
		t.Fatalf("sent %v, want each id once", seenIDs)
	}
}

// --- T4: RDP ---------------------------------------------------------------

func TestGetRdpFileReturnsTheProfile(t *testing.T) {
	c, done := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			t.Errorf("method = %q, want POST", r.Method)
		}
		if r.URL.Path != "/api/access-requests/ar-1/rdp-credentials" {
			t.Errorf("path = %q", r.URL.Path)
		}
		writeEnvelope(w, map[string]interface{}{
			"filename":  "shellius-ar-1.rdp",
			"content":   "full address:s:10.0.0.4:3389\r\nusername:s:Administrator",
			"expiresAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
		})
	}))
	defer done()

	file, err := c.GetRdpFile("ar-1")
	if err != nil {
		t.Fatalf("GetRdpFile: %v", err)
	}
	if file.Filename != "shellius-ar-1.rdp" {
		t.Fatalf("filename = %q", file.Filename)
	}
	if !strings.Contains(file.Content, "full address") {
		t.Fatalf("content does not look like an .rdp profile: %q", file.Content)
	}
	// The backend writes no credential into this file. If that ever changes,
	// every assumption in internal/rdp about the file not being a secret
	// changes with it, so assert the contract here where it is visible.
	if strings.Contains(strings.ToLower(file.Content), "password") {
		t.Fatal("the .rdp profile now contains a password field — internal/rdp's design must be revisited")
	}
	if file.ExpiresAt == nil {
		t.Fatal("expiresAt was not decoded")
	}
}

// The web-terminal fallback needs the protocol to size or refuse a session,
// and the URL it returns is relative.
func TestStartWebTerminalCarriesTheProtocol(t *testing.T) {
	c, done := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeEnvelope(w, map[string]interface{}{
			"url": "/terminal?requestId=ar-1", "protocol": "RDP",
		})
	}))
	defer done()

	res, err := c.StartWebTerminal("ar-1")
	if err != nil {
		t.Fatalf("StartWebTerminal: %v", err)
	}
	if res.Protocol != "RDP" {
		t.Fatalf("protocol = %q, want RDP", res.Protocol)
	}
	if res.URL != "/terminal?requestId=ar-1" {
		t.Fatalf("url = %q", res.URL)
	}
}
