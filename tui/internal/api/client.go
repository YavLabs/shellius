package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/shellius/tui/internal/auth"
	"github.com/shellius/tui/internal/config"
	"github.com/shellius/tui/internal/logx"
)

// ErrTokenRefreshFailed is returned by Client.do when the background token
// refresh fails for a transient reason. The caller should surface this as a
// non-destructive warning (toast) and NOT wipe the config — the existing
// tokens are left intact so the user can retry without re-authenticating.
var ErrTokenRefreshFailed = errors.New("token refresh failed")

// ErrSessionExpired is re-exported from the auth package and surfaced when
// the refresh endpoint definitively rejects the stored refresh token (HTTP
// 401). The TUI app should route the user to the login screen.
var ErrSessionExpired = auth.ErrSessionExpired

// HTTPError is returned by Client.do when the server responds with
// success:false. It carries the HTTP status code plus the structured
// error fields from the API envelope.
type HTTPError struct {
	Status  int
	Code    string
	Message string
}

func (e *HTTPError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("API error (HTTP %d, code %s): %s", e.Status, e.Code, e.Message)
	}
	return fmt.Sprintf("API error (HTTP %d): %s", e.Status, e.Message)
}

// Host represents a server entry returned by the Shellius API.
type Host struct {
	ID           string `json:"id"`
	Name         string `json:"displayName"`
	Hostname     string `json:"hostname"`
	Port         int    `json:"port"`
	Environment  string `json:"environment"`
	CustomerName string `json:"customerName"`
	// Principal / SSH user to use when connecting.
	Principal string `json:"sshUser"`
	// AccessStatus is one of: "direct", "requires_approval", "no_access".
	AccessStatus string `json:"accessStatus"`
	// AccessExpiry is set when the user already has an active approved request.
	AccessExpiry *time.Time `json:"accessExpiry,omitempty"`
	CustomerID   string     `json:"customerId"`
}

// AccessRequest mirrors the server-side AccessRequest model.
type AccessRequest struct {
	ID                 string     `json:"id"`
	Status             string     `json:"status"` // PENDING | APPROVED | DENIED | EXPIRED | REVOKED
	ServerID           string     `json:"serverId"`
	RequesterID        string     `json:"requesterId"`
	RequestedPrincipal string     `json:"requestedPrincipal"`
	RequestedDuration  int        `json:"requestedDuration"`
	Reason             string     `json:"reason"`
	DeniedReason       string     `json:"deniedReason"`
	Protocol           string     `json:"protocol"`
	ExpiresAt          *time.Time `json:"expiresAt,omitempty"`
	CreatedAt          time.Time  `json:"createdAt"`
	// Server is inlined when the backend supports it.
	Server *AccessRequestServer `json:"server,omitempty"`
}

// AccessRequestServer is the server info inlined into an access request response.
type AccessRequestServer struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	Hostname    string `json:"hostname"`
	Port        int    `json:"port"`
	Environment string `json:"environment"`
	SshUser     string `json:"sshUser"`
	Customer    struct {
		Name string `json:"name"`
	} `json:"customer"`
}

// SshCreds is returned by POST /api/access-requests/:id/ssh-credentials.
type SshCreds struct {
	PrivateKey     string     `json:"privateKey"`
	Certificate    string     `json:"certificate"`
	Hostname       string     `json:"hostname"`
	// Address is the IP address the backend resolved for the server. The
	// TUI MUST prefer this over Hostname for the actual ssh -i target —
	// the backend's DNS view of the world (inside docker) is canonical, and
	// the user's local DNS may resolve the server's display hostname to a
	// completely different machine that doesn't trust the Shellius CA.
	// (This is exactly how prod-databases broke for the first user: their
	// Mac resolved the name to an unrelated host and ssh got cert-rejected.)
	Address        string     `json:"address"`
	Port           int        `json:"port"`
	Username       string     `json:"username"`
	ExpiresAt      *time.Time `json:"expiresAt,omitempty"`
	ConnectCommand string     `json:"connectCommand"`
}

// ConnectResult is returned by POST /api/access-requests/:id/connect.
//
// URL is relative to the Shellius web app ("/terminal?requestId=…"), so it
// must be joined onto ServerURL before being handed to a browser.
type ConnectResult struct {
	URL string `json:"url"`
	// Protocol is the REQUEST's protocol (SSH | RDP), not the server's: on a
	// `both` server only the request says which of the two was asked for.
	Protocol  string     `json:"protocol"`
	ExpiresAt *time.Time `json:"expiresAt,omitempty"`
}

// AccessIntent is returned by GET /api/access-requests/intent?serverId=...
// It gives the TUI all the context it needs before showing the request form.
type AccessIntent struct {
	HasActiveAccess     bool     `json:"hasActiveAccess"`
	HasPendingRequest   bool     `json:"hasPendingRequest"`
	PreferredPrincipal  string   `json:"preferredPrincipal"`
	AllowedPrincipals   []string `json:"allowedPrincipals"`
	RequiresApproval    bool     `json:"requiresApproval"`
	JitEnabled          bool     `json:"jitEnabled"`
	Protocol            string   `json:"protocol"`
	ActiveAccessRequest *AccessRequest `json:"activeAccessRequest,omitempty"`
}

// Client is the Shellius API HTTP client.
type Client struct {
	BaseURL    string
	HTTPClient *http.Client
	Config     *config.Config
}

// New creates a new API client.
func New(cfg *config.Config) *Client {
	return &Client{
		BaseURL:    cfg.ServerURL,
		HTTPClient: &http.Client{Timeout: 30 * time.Second},
		Config:     cfg,
	}
}

// apiEnvelope is the standard response wrapper.
type apiEnvelope struct {
	Success bool            `json:"success"`
	Data    json.RawMessage `json:"data"`
	Error   json.RawMessage `json:"error"`
}

// apiErrorPayload is the structured error object inside the envelope.
type apiErrorPayload struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (c *Client) do(method, path string, body interface{}, result interface{}) error {
	if err := auth.RefreshIfNeeded(c.Config); err != nil {
		// Log the failure at WARN so it shows up in shellius doctor output.
		logx.Warnf("api: token refresh failed (oldExpiry=%s): %v",
			c.Config.TokenExpiresAt.UTC().Format(time.RFC3339), err)
		// A definitive 401 from /api/auth/refresh means the refresh token
		// has been rotated, revoked, or wiped — there's no recovery path
		// other than re-authenticating, so propagate the sentinel as-is
		// so the app can route to the login screen.
		if errors.Is(err, auth.ErrSessionExpired) {
			return err
		}
		// Otherwise treat it as a transient failure — leave the existing
		// tokens intact so the user can retry without re-authenticating.
		return fmt.Errorf("%w: %v", ErrTokenRefreshFailed, err)
	}

	var bodyReader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshal request body: %w", err)
		}
		bodyReader = bytes.NewReader(b)
	}

	req, err := http.NewRequest(method, c.BaseURL+path, bodyReader)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.Config.AccessToken)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("HTTP %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNoContent {
		return nil
	}

	var envelope apiEnvelope
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}

	if !envelope.Success {
		// Try to parse structured error payload.
		httpErr := &HTTPError{Status: resp.StatusCode}
		if len(envelope.Error) > 0 {
			var payload apiErrorPayload
			if json.Unmarshal(envelope.Error, &payload) == nil {
				httpErr.Code = payload.Code
				httpErr.Message = payload.Message
			} else {
				// Fallback: treat raw JSON as the message string.
				httpErr.Message = string(envelope.Error)
			}
		}
		if httpErr.Message == "" {
			httpErr.Message = http.StatusText(resp.StatusCode)
		}
		return httpErr
	}

	if result != nil && len(envelope.Data) > 0 {
		if err := json.Unmarshal(envelope.Data, result); err != nil {
			return fmt.Errorf("decode data: %w", err)
		}
	}
	return nil
}

// The list endpoints cap a page at 100 rows and default to 25 when asked for
// nothing — which is what this client used to do. Anyone with more than 25
// servers could not see, or connect to, the rest of them from the CLI.
//
// The two endpoints do not agree on the parameter's name: /api/servers takes
// `pageSize`, /api/access-requests takes `limit`. Each pager names its own.
const apiPageSize = 100

// A ceiling on how many pages one listing walks — 50,000 rows, far beyond any
// real inventory. It is here so that a backend reporting a `total` it never
// delivers makes the CLI slow rather than infinite.
const maxListPages = 500

// serverListItem is one row of GET /api/servers.
type serverListItem struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	Hostname    string `json:"hostname"`
	Port        int    `json:"port"`
	Environment string `json:"environment"`
	SshUser     string `json:"sshUser"`
	IsActive    bool   `json:"isActive"`
	Customer    struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"customer"`
}

// serverListData is the shape returned by GET /api/servers.
type serverListData struct {
	Items []serverListItem `json:"items"`
	// The server echoes what it actually used, which is not necessarily what
	// was asked for — it silently caps pageSize at 100.
	Total    int `json:"total"`
	Page     int `json:"page"`
	PageSize int `json:"pageSize"`
}

// Access status values used in Host.AccessStatus.
const (
	// AccessActive — an APPROVED, unexpired request exists: connect now.
	AccessActive = "active"
	// AccessPending — a request is awaiting a decision.
	AccessPending = "pending"
	// AccessDirect — policy allows access without approval.
	AccessDirect = "direct"
	// AccessRequiresApproval — policy allows it, but only after approval.
	AccessRequiresApproval = "requires_approval"
	// AccessNone — no matching policy, or a DENY policy: asking will fail.
	AccessNone = "no_access"
)

// toHost converts one API row into the CLI's view of a host.
//
// This is the FALLBACK labelling, used only when the intents call could not
// answer for this server. "prod means approval, everything else is direct" is
// a guess: it is right about prod and wrong about every non-prod server with
// no matching policy, a DENY policy, or a policy that sets requireApproval.
// The real verdict comes from applyIntents below.
func toHost(s serverListItem, skipsProdApproval bool) Host {
	// Prod needs an approved request unless the role may skip it
	// (access.prod_bypass — Admin by default, configurable per role).
	accessStatus := AccessDirect
	if s.Environment == "prod" && !skipsProdApproval {
		accessStatus = AccessRequiresApproval
	}
	port := s.Port
	if port == 0 {
		port = 22
	}
	return Host{
		ID:           s.ID,
		Name:         s.DisplayName,
		Hostname:     s.Hostname,
		Port:         port,
		Environment:  s.Environment,
		CustomerName: s.Customer.Name,
		CustomerID:   s.Customer.ID,
		Principal:    s.SshUser,
		AccessStatus: accessStatus,
	}
}

// ListHosts retrieves every server the user can see, a page at a time, and
// annotates each with its access status. No dedicated /api/tui/hosts endpoint
// exists in the backend, so this uses GET /api/servers.
//
// Inactive servers are dropped from the result but still counted towards the
// server's `total`, so the loop's progress is tracked by rows SEEN rather than
// by rows returned — otherwise an inventory whose tail is all deactivated
// hosts would page until the cap.
func (c *Client) ListHosts() ([]Host, error) {
	skipsProdApproval := c.Config.Has("access.prod_bypass")

	hosts := make([]Host, 0, apiPageSize)
	seen := make(map[string]struct{})

	for page := 1; page <= maxListPages; page++ {
		var data serverListData
		path := fmt.Sprintf("/api/servers?page=%d&pageSize=%d", page, apiPageSize)
		if err := c.do("GET", path, nil, &data); err != nil {
			return nil, err
		}
		if len(data.Items) == 0 {
			break
		}

		fresh := 0
		for _, s := range data.Items {
			if s.ID != "" {
				if _, dup := seen[s.ID]; dup {
					continue
				}
				seen[s.ID] = struct{}{}
			}
			fresh++
			if !s.IsActive {
				continue
			}
			hosts = append(hosts, toHost(s, skipsProdApproval))
		}

		// Offset paging over a list ordered by creation date: a server added
		// between two requests shifts every later row down one, so a page can
		// repeat rows an earlier page already returned. Deduping absorbs that.
		// A page that is ENTIRELY duplicates means no progress is being made,
		// and continuing would fetch the same rows for ever.
		if fresh == 0 {
			break
		}
		if data.Total > 0 && len(seen) >= data.Total {
			break
		}
		// Fallback for a backend that reports no total: a short page is the
		// last page. Compare against the size the server says it used, never
		// the size we asked for.
		size := data.PageSize
		if size <= 0 {
			size = apiPageSize
		}
		if len(data.Items) < size {
			break
		}
	}

	applyIntents(c, hosts)
	return hosts, nil
}

// applyIntents replaces the environment-based guess in Host.AccessStatus with
// the server's own verdict, for every host the /intents endpoint answered for.
//
// Everything about this function is written to be non-fatal. The host list is
// the CLI's main screen; losing it because a decorating call failed would be a
// far worse bug than the inaccurate label it exists to fix. So:
//   - a total failure leaves every row on the prod-only heuristic;
//   - a partial failure (batch 3 of 5 errored) keeps the rows it did get;
//   - a host missing from the response keeps the heuristic;
//   - an older backend that answers without a policy verdict still gets the
//     active/pending half of the answer, which it does return.
func applyIntents(c *Client, hosts []Host) {
	if len(hosts) == 0 {
		return
	}

	ids := make([]string, 0, len(hosts))
	for _, h := range hosts {
		if h.ID != "" {
			ids = append(ids, h.ID)
		}
	}
	if len(ids) == 0 {
		return
	}

	intents, err := c.GetAccessIntents(ids)
	if err != nil {
		logx.Warnf("api: access intents unavailable, falling back to the prod-only label (%d/%d servers answered): %v",
			len(intents), len(ids), err)
	}
	if len(intents) == 0 {
		return
	}

	for i := range hosts {
		intent, ok := intents[hosts[i].ID]
		if !ok {
			// Deleted between the list call and this one, or an id the server
			// chose not to answer for. The heuristic label stands.
			continue
		}

		// Active access first: an approved request beats any policy verdict,
		// because it is a grant that has already been made. Note the backend
		// returns hasActiveAccess for admins on the same terms as anyone else
		// — it reflects a real AccessRequest row, not a role.
		switch {
		case intent.HasActiveAccess:
			hosts[i].AccessStatus = AccessActive
			hosts[i].AccessExpiry = intent.ExpiresAt
		case intent.HasPendingRequest:
			hosts[i].AccessStatus = AccessPending
		case !intent.HasPolicyVerdict:
			// Older backend: keep the heuristic rather than invent a verdict.
		case !intent.Allowed:
			hosts[i].AccessStatus = AccessNone
		case intent.RequiresApproval:
			hosts[i].AccessStatus = AccessRequiresApproval
		default:
			hosts[i].AccessStatus = AccessDirect
		}
	}
}

// accessRequestListData is the shape returned by GET /api/access-requests.
type accessRequestListData struct {
	Items []AccessRequest `json:"items"`
	// Some backends wrap in accessRequests instead of items.
	AccessRequests []AccessRequest `json:"accessRequests"`
	Total          int             `json:"total"`
}

// decodeRequestPage decodes one page of GET /api/access-requests.
//
// The endpoint has been seen to return both a bare array and an envelope with
// `items` / `accessRequests`, and the difference decides whether paging is
// possible at all: a bare array carries no total and no page size, so there is
// nothing to page with. Asking such a response for page 2 would most likely
// return the same rows again, so `paged == false` means "take this and stop".
func decodeRequestPage(raw json.RawMessage) ([]AccessRequest, bool, int, error) {
	var items []AccessRequest
	if err := json.Unmarshal(raw, &items); err == nil {
		return items, false, 0, nil
	}
	var data accessRequestListData
	if err := json.Unmarshal(raw, &data); err != nil {
		return nil, false, 0, fmt.Errorf("decode access requests: %w", err)
	}
	items = data.Items
	if len(items) == 0 {
		items = data.AccessRequests
	}
	return items, true, data.Total, nil
}

// listAccessRequests walks every page of GET /api/access-requests for one
// query. `query` is the filter portion only ("tab=mine&status=APPROVED");
// paging parameters are added here so no caller can forget them.
func (c *Client) listAccessRequests(query string) ([]AccessRequest, error) {
	var all []AccessRequest
	seen := make(map[string]struct{})

	for page := 1; page <= maxListPages; page++ {
		var raw json.RawMessage
		path := fmt.Sprintf("/api/access-requests?%s&page=%d&limit=%d", query, page, apiPageSize)
		if err := c.do("GET", path, nil, &raw); err != nil {
			return nil, err
		}

		items, paged, total, err := decodeRequestPage(raw)
		if err != nil {
			return nil, err
		}
		if len(items) == 0 {
			break
		}

		fresh := 0
		for _, r := range items {
			// A row with no id cannot be deduped; keeping it is the lesser
			// harm, since dropping it would hide a request from its owner.
			if r.ID != "" {
				if _, dup := seen[r.ID]; dup {
					continue
				}
				seen[r.ID] = struct{}{}
			}
			all = append(all, r)
			fresh++
		}

		if !paged || fresh == 0 {
			break
		}
		if total > 0 && len(all) >= total {
			break
		}
		if len(items) < apiPageSize {
			break
		}
	}

	return all, nil
}

// ListMyActiveAccessRequests fetches the caller's active (APPROVED, not expired)
// access requests. Uses tab=mine&status=APPROVED per the API contract.
func (c *Client) ListMyActiveAccessRequests() ([]AccessRequest, error) {
	requests, err := c.listAccessRequests("tab=mine&status=APPROVED")
	if err != nil {
		return nil, err
	}

	now := time.Now()
	var active []AccessRequest
	for _, r := range requests {
		if r.Status != "APPROVED" {
			continue
		}
		if r.ExpiresAt != nil && r.ExpiresAt.Before(now) {
			continue
		}
		active = append(active, r)
	}
	return active, nil
}

// ListMyAccessRequests fetches all access requests for the current user
// across all statuses. Used by the /myrequests view.
func (c *Client) ListMyAccessRequests() ([]AccessRequest, error) {
	return c.listAccessRequests("tab=mine")
}

// SubmitAccessRequest creates a new access request.
func (c *Client) SubmitAccessRequest(serverID, reason string, durationSec int, principal, protocol string) (AccessRequest, error) {
	if protocol == "" {
		protocol = "SSH"
	}
	body := map[string]interface{}{
		"serverId":           serverID,
		"reason":             reason,
		"requestedDuration":  durationSec,
		"requestedPrincipal": principal,
		"protocol":           protocol,
	}
	var data struct {
		AccessRequest AccessRequest `json:"accessRequest"`
	}
	if err := c.do("POST", "/api/access-requests", body, &data); err != nil {
		return AccessRequest{}, err
	}
	return data.AccessRequest, nil
}

// GetAccessRequest retrieves the current state of an access request by ID.
func (c *Client) GetAccessRequest(id string) (AccessRequest, error) {
	var data struct {
		AccessRequest AccessRequest `json:"accessRequest"`
	}
	if err := c.do("GET", "/api/access-requests/"+id, nil, &data); err != nil {
		return AccessRequest{}, err
	}
	return data.AccessRequest, nil
}

// GetAccessIntent calls GET /api/access-requests/intent?serverId=... and
// returns structured context needed to pre-fill the request form.
func (c *Client) GetAccessIntent(serverID string) (AccessIntent, error) {
	var intent AccessIntent
	if err := c.do("GET", "/api/access-requests/intent?serverId="+serverID, nil, &intent); err != nil {
		return AccessIntent{}, err
	}
	return intent, nil
}

// GetActiveAccessForServer calls GET /api/access-requests/by-server/:id/active.
// Returns nil, nil when there is no active access request.
func (c *Client) GetActiveAccessForServer(serverID string) (*AccessRequest, error) {
	var data struct {
		AccessRequest *AccessRequest `json:"accessRequest"`
	}
	if err := c.do("GET", "/api/access-requests/by-server/"+serverID+"/active", nil, &data); err != nil {
		return nil, err
	}
	return data.AccessRequest, nil
}

// GetSshCredentials fetches ephemeral SSH credentials for an approved access request.
func (c *Client) GetSshCredentials(id string) (SshCreds, error) {
	var data struct {
		Credentials SshCreds `json:"credentials"`
	}
	if err := c.do("POST", "/api/access-requests/"+id+"/ssh-credentials", nil, &data); err != nil {
		return SshCreds{}, err
	}
	return data.Credentials, nil
}

// StartWebTerminal calls POST /api/access-requests/:id/connect and returns
// the web terminal URL. Used as a fallback when key download is disabled by
// policy (HTTP 403 with code indicating key download disabled).
func (c *Client) StartWebTerminal(id string) (ConnectResult, error) {
	var result ConnectResult
	if err := c.do("POST", "/api/access-requests/"+id+"/connect", nil, &result); err != nil {
		return ConnectResult{}, err
	}
	return result, nil
}

// ---------------------------------------------------------------------------
// Profile — GET /api/auth/me
// ---------------------------------------------------------------------------

// Profile is the subset of GET /api/auth/me the CLI cares about. The backend
// builds it in authService.getProfile(), which spreads accessOf(user); that is
// where `permissions` and `roleInfo` come from. `role` is the base tier
// (member|manager|admin|super_admin), kept for older policy-subject matching —
// never gate a feature on it.
type Profile struct {
	ID          string   `json:"id"`
	Email       string   `json:"email"`
	Name        string   `json:"name"`
	Role        string   `json:"role"`
	Permissions []string `json:"permissions"`
	OrgID       string   `json:"orgId"`
	RoleInfo    *struct {
		ID       string `json:"id"`
		Key      string `json:"key"`
		Name     string `json:"name"`
		BaseRole string `json:"baseRole"`
	} `json:"roleInfo"`
	Organization *struct {
		ID   string `json:"id"`
		Slug string `json:"slug"`
		Name string `json:"name"`
	} `json:"organization"`
}

// GetProfile calls GET /api/auth/me.
func (c *Client) GetProfile() (Profile, error) {
	var data struct {
		User Profile `json:"user"`
	}
	if err := c.do("GET", "/api/auth/me", nil, &data); err != nil {
		return Profile{}, err
	}
	return data.User, nil
}

// RefreshPermissions re-reads the caller's role and permissions from the
// server and writes them into the config (and to the credentials file, so a
// restart does not resurrect the stale set).
//
// Permissions used to be captured once, at sign-in, and never revisited:
// refreshing the access token does not return them. A user whose role was
// changed — or revoked — kept seeing the menu entries and the "direct access"
// labels of their old role until they signed out and back in. This is the
// call that fixes that, and it runs at start-up and after any 403
// PERMISSION_DENIED (the moment the local copy is provably wrong).
//
// It reports whether anything actually changed, so a caller can decide
// whether to redraw or to tell the user their access changed underneath them.
func (c *Client) RefreshPermissions() (changed bool, err error) {
	profile, err := c.GetProfile()
	if err != nil {
		return false, err
	}

	before := permissionKey(c.Config.Permissions)
	beforeRole := c.Config.Role + "\x00" + c.Config.RoleName

	// A user with literally zero permissions is representable, so an empty
	// slice must still replace the old list — but it has to be non-nil, or
	// config.Has falls back to the legacy "admin tier implies prod_bypass"
	// guess and silently re-grants what the server just took away.
	perms := profile.Permissions
	if perms == nil {
		perms = []string{}
	}
	c.Config.Permissions = perms
	if profile.Role != "" {
		c.Config.Role = profile.Role
	}
	if profile.RoleInfo != nil {
		c.Config.RoleName = profile.RoleInfo.Name
	} else {
		// No custom role assigned any more: drop a stale display name rather
		// than keep showing a role the user no longer holds.
		c.Config.RoleName = ""
	}
	if profile.Email != "" {
		c.Config.Username = profile.Email
	}
	if profile.OrgID != "" {
		c.Config.OrgID = profile.OrgID
	}
	if profile.Organization != nil && profile.Organization.Slug != "" {
		c.Config.OrgSlug = profile.Organization.Slug
	}

	changed = before != permissionKey(c.Config.Permissions) ||
		beforeRole != c.Config.Role+"\x00"+c.Config.RoleName

	// Persisting is what makes the refresh survive a restart. A failure here
	// is not fatal — the in-memory set is already correct for this session —
	// but it must be reported, not swallowed.
	if saveErr := c.Config.Save(); saveErr != nil {
		logx.Warnf("api: refreshed permissions but could not save credentials: %v", saveErr)
		return changed, fmt.Errorf("save refreshed permissions: %w", saveErr)
	}
	return changed, nil
}

// permissionKey builds an order-independent identity for a permission set so
// "changed" does not fire merely because the server returned them in a
// different order.
func permissionKey(perms []string) string {
	sorted := append([]string(nil), perms...)
	sort.Strings(sorted)
	return strings.Join(sorted, "\x00")
}

// IsPermissionDenied reports whether err is the API's own 403 refusal, as
// opposed to any other 403 (key download disabled by policy, "only the
// requester may…", and so on). Only this one warrants re-reading permissions.
func IsPermissionDenied(err error) bool {
	var httpErr *HTTPError
	if !errors.As(err, &httpErr) {
		return false
	}
	return httpErr.Status == http.StatusForbidden && httpErr.Code == "PERMISSION_DENIED"
}

// Message returns the API's own explanation of a failure when there is one,
// falling back to the full error text. A 403 from Shellius says exactly which
// permission is missing; showing "API error (HTTP 403, code PERMISSION_DENIED)"
// instead of that sentence tells the user nothing they can act on.
func Message(err error) string {
	if err == nil {
		return ""
	}
	var httpErr *HTTPError
	if errors.As(err, &httpErr) && strings.TrimSpace(httpErr.Message) != "" {
		return httpErr.Message
	}
	return err.Error()
}

// ---------------------------------------------------------------------------
// Bulk access intents — GET /api/access-requests/intents
// ---------------------------------------------------------------------------

// intentsBatchSize is the number of server ids per /intents request.
//
// Not a guess and not from the docs: backend/src/routes/accessRequests.js
// rejects the whole call with HTTP 400 at `serverIds.length > 50`, so 50 is
// the largest batch that is ever answered.
const intentsBatchSize = 50

// BulkIntent is one entry of GET /api/access-requests/intents.
type BulkIntent struct {
	HasActiveAccess   bool
	ActiveRequestID   string
	HasPendingRequest bool
	PendingRequestID  string
	ExpiresAt         *time.Time

	// Policy verdict. HasPolicyVerdict is false when the server did not send
	// one — every Shellius before this change answered /intents with the
	// access fields only. Reading a missing `allowed` as the Go zero value
	// would mark an entire inventory "no access" against an older backend,
	// which is worse than the prod-only guess it replaced.
	HasPolicyVerdict bool
	Allowed          bool
	RequiresApproval bool
	IsProduction     bool
	Reason           string
}

// bulkIntentWire is the on-the-wire form. The policy fields are pointers
// precisely so "absent" and "false" stay distinguishable.
type bulkIntentWire struct {
	HasActiveAccess   bool       `json:"hasActiveAccess"`
	ActiveRequestID   string     `json:"activeRequestId"`
	HasPendingRequest bool       `json:"hasPendingRequest"`
	PendingRequestID  string     `json:"pendingRequestId"`
	ExpiresAt         *time.Time `json:"expiresAt"`
	Allowed           *bool      `json:"allowed"`
	RequiresApproval  *bool      `json:"requiresApproval"`
	IsProduction      *bool      `json:"isProduction"`
	Reason            *string    `json:"reason"`
}

// GetAccessIntents fetches intents for many servers at once, in batches of
// intentsBatchSize.
//
// It returns whatever it managed to collect ALONGSIDE any error: a caller
// rendering a list would rather show most rows correctly and fall back on the
// remainder than show nothing. Callers that need all-or-nothing must check the
// error; callers that are decorating a list should use the map regardless.
func (c *Client) GetAccessIntents(serverIDs []string) (map[string]BulkIntent, error) {
	out := make(map[string]BulkIntent, len(serverIDs))

	// Dedupe: the endpoint dedupes server-side anyway, but sending duplicates
	// wastes room in a batch that is capped at 50.
	ids := make([]string, 0, len(serverIDs))
	seen := make(map[string]struct{}, len(serverIDs))
	for _, id := range serverIDs {
		if id == "" {
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	// An empty batch is a 400 from the API ("serverIds query parameter is
	// required"), so an empty inventory must not produce a request at all.
	if len(ids) == 0 {
		return out, nil
	}

	for start := 0; start < len(ids); start += intentsBatchSize {
		end := start + intentsBatchSize
		if end > len(ids) {
			end = len(ids)
		}
		batch := ids[start:end]

		escaped := make([]string, len(batch))
		for i, id := range batch {
			escaped[i] = url.QueryEscape(id)
		}
		path := "/api/access-requests/intents?serverIds=" + strings.Join(escaped, ",")

		var data struct {
			Intents map[string]bulkIntentWire `json:"intents"`
		}
		if err := c.do("GET", path, nil, &data); err != nil {
			// Partial failure: hand back the batches that did succeed so the
			// caller can decorate those rows and degrade only the rest.
			return out, err
		}
		for id, w := range data.Intents {
			out[id] = w.toIntent()
		}
	}

	return out, nil
}

func (w bulkIntentWire) toIntent() BulkIntent {
	bi := BulkIntent{
		HasActiveAccess:   w.HasActiveAccess,
		ActiveRequestID:   w.ActiveRequestID,
		HasPendingRequest: w.HasPendingRequest,
		PendingRequestID:  w.PendingRequestID,
		ExpiresAt:         w.ExpiresAt,
	}
	if w.Allowed != nil {
		bi.HasPolicyVerdict = true
		bi.Allowed = *w.Allowed
		if w.RequiresApproval != nil {
			bi.RequiresApproval = *w.RequiresApproval
		}
		if w.IsProduction != nil {
			bi.IsProduction = *w.IsProduction
		}
		if w.Reason != nil {
			bi.Reason = *w.Reason
		}
	}
	return bi
}

// ---------------------------------------------------------------------------
// RDP — POST /api/access-requests/:id/rdp-credentials
// ---------------------------------------------------------------------------

// RdpFile is what POST /api/access-requests/:id/rdp-credentials returns.
//
// Content is a Windows MSTSC-format .rdp profile and — this is the part that
// decides the whole design — it holds NO credential. The backend
// (accessRequestService.generateRdpFile) deliberately writes neither the
// host's RDP password nor the Guacamole connection token, because that
// token's plaintext contains the password. What the file carries is the
// address, port, username and display/gateway settings.
//
// Consequences the CLI has to live with:
//   - Nothing secret is written to disk, so the file is not a credential leak.
//     It is still written 0600 in a private directory and deleted afterwards,
//     because it discloses internal addressing and a valid username.
//   - The file only connects where the user's own machine can already reach
//     the host. Credential injection happens only in the browser session
//     (WebSocket → guacd), so the web client stays the fallback that always
//     works — and the only option on a headless box.
type RdpFile struct {
	Filename  string     `json:"filename"`
	Content   string     `json:"content"`
	ExpiresAt *time.Time `json:"expiresAt,omitempty"`
}

// GetRdpFile fetches the .rdp profile for an approved RDP access request.
func (c *Client) GetRdpFile(id string) (RdpFile, error) {
	var file RdpFile
	if err := c.do("POST", "/api/access-requests/"+id+"/rdp-credentials", nil, &file); err != nil {
		return RdpFile{}, err
	}
	return file, nil
}
