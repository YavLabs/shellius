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
// refresh fails. The caller should surface this as a non-destructive warning
// (toast) and NOT wipe the config — the existing tokens are left intact so the
// user can retry without re-authenticating.
var ErrTokenRefreshFailed = errors.New("token refresh failed")

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
	Error   interface{}     `json:"error"`
}

func (c *Client) do(method, path string, body interface{}, result interface{}) error {
	if err := auth.RefreshIfNeeded(c.Config); err != nil {
		// Log the failure at WARN so it shows up in shellius doctor output.
		// We deliberately do NOT wipe the config — only shellius logout may
		// clear credentials. The caller receives ErrTokenRefreshFailed so it
		// can surface a non-destructive toast and then proceed with whatever
		// access token is currently cached (it may still be valid).
		logx.Warnf("api: token refresh failed (oldExpiry=%s): %v",
			c.Config.TokenExpiresAt.UTC().Format(time.RFC3339), err)
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
		errMsg := fmt.Sprintf("%v", envelope.Error)
		return fmt.Errorf("API error (HTTP %d): %s", resp.StatusCode, errMsg)
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
}

// ListMyActiveAccessRequests fetches the caller's active (APPROVED, not expired)
// access requests. It calls GET /api/access-requests and filters client-side
// since older backends may not support mine/active query params.
func (c *Client) ListMyActiveAccessRequests() ([]AccessRequest, error) {
	var raw json.RawMessage
	if err := c.do("GET", "/api/access-requests?mine=true&status=APPROVED", nil, &raw); err != nil {
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

// SubmitAccessRequest creates a new access request for a production server.
func (c *Client) SubmitAccessRequest(serverID, reason string, durationSec int, principal string) (AccessRequest, error) {
	body := map[string]interface{}{
		"serverId":           serverID,
		"reason":             reason,
		"requestedDuration":  durationSec,
		"requestedPrincipal": principal,
		"protocol":           "SSH",
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
