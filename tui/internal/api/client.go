package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
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
type ConnectResult struct {
	URL       string     `json:"url"`
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

// toHost converts one API row into the CLI's view of a host.
func toHost(s serverListItem, skipsProdApproval bool) Host {
	// Prod needs an approved request unless the role may skip it
	// (access.prod_bypass — Admin by default, configurable per role).
	accessStatus := "direct"
	if s.Environment == "prod" && !skipsProdApproval {
		accessStatus = "requires_approval"
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

	return hosts, nil
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
