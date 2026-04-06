package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/shellius/tui/internal/auth"
	"github.com/shellius/tui/internal/config"
)

// Host represents a server entry returned by the Shellius API.
type Host struct {
	ID           string `json:"id"`
	Name         string `json:"displayName"`
	Hostname     string `json:"hostname"`
	Port         int    `json:"port"`
	Environment  string `json:"environment"`
	CustomerName string `json:"customerName"`
	// Principal / SSH user to use when connecting.
	Principal    string `json:"sshUser"`
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
		// Non-fatal: proceed with existing token.
		_ = err
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
	Servers []struct {
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
	} `json:"servers"`
}

// ListHosts retrieves all servers the user can see and annotates them with
// access status. No dedicated /api/tui/hosts endpoint exists in the backend,
// so we use GET /api/servers instead.
func (c *Client) ListHosts() ([]Host, error) {
	var data serverListData
	if err := c.do("GET", "/api/servers", nil, &data); err != nil {
		return nil, err
	}

	hosts := make([]Host, 0, len(data.Servers))
	for _, s := range data.Servers {
		if !s.IsActive {
			continue
		}
		accessStatus := "direct"
		if s.Environment == "prod" {
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
