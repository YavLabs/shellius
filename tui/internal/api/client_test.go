package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
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
	c := &Client{BaseURL: srv.URL, HTTPClient: srv.Client(), Config: cfg}
	return c, srv.Close
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
