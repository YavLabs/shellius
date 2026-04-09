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

// serverListData is the shape returned by GET /api/servers.
type serverListData struct {
	Items []struct {
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
	} `json:"items"`
}

// ListHosts retrieves all servers the user can see and annotates them with
// access status. No dedicated /api/tui/hosts endpoint exists in the backend,
// so we use GET /api/servers instead.
func (c *Client) ListHosts() ([]Host, error) {
	var data serverListData
	if err := c.do("GET", "/api/servers", nil, &data); err != nil {
		return nil, err
	}

	isSuperAdmin := c.Config.Role == "super_admin"

	hosts := make([]Host, 0, len(data.Items))
	for _, s := range data.Items {
		if !s.IsActive {
			continue
		}
		accessStatus := "direct"
		if s.Environment == "prod" && !isSuperAdmin {
			accessStatus = "requires_approval"
		}
		port := s.Port
		if port == 0 {
			port = 22
		}
		hosts = append(hosts, Host{
			ID:           s.ID,
			Name:         s.DisplayName,
			Hostname:     s.Hostname,
			Port:         port,
			Environment:  s.Environment,
			CustomerName: s.Customer.Name,
			CustomerID:   s.Customer.ID,
			Principal:    s.SshUser,
			AccessStatus: accessStatus,
		})
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

// ListMyActiveAccessRequests fetches the caller's active (APPROVED, not expired)
// access requests. Uses tab=mine&status=APPROVED per the API contract.
func (c *Client) ListMyActiveAccessRequests() ([]AccessRequest, error) {
	var raw json.RawMessage
	if err := c.do("GET", "/api/access-requests?tab=mine&status=APPROVED", nil, &raw); err != nil {
		return nil, err
	}

	// Try array first, then object with items/accessRequests.
	var requests []AccessRequest
	if err := json.Unmarshal(raw, &requests); err != nil {
		var data accessRequestListData
		if err2 := json.Unmarshal(raw, &data); err2 != nil {
			return nil, fmt.Errorf("decode access requests: %w", err2)
		}
		requests = data.Items
		if len(requests) == 0 {
			requests = data.AccessRequests
		}
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
	var raw json.RawMessage
	if err := c.do("GET", "/api/access-requests?tab=mine&limit=50", nil, &raw); err != nil {
		return nil, err
	}

	var requests []AccessRequest
	if err := json.Unmarshal(raw, &requests); err != nil {
		var data accessRequestListData
		if err2 := json.Unmarshal(raw, &data); err2 != nil {
			return nil, fmt.Errorf("decode access requests: %w", err2)
		}
		requests = data.Items
		if len(requests) == 0 {
			requests = data.AccessRequests
		}
	}
	return requests, nil
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
