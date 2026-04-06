package auth

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/shellius/tui/internal/config"
)

// SaveTokens persists token data returned from a successful device poll into
// the config and writes it to disk.
func SaveTokens(cfg *config.Config, token TokenResponse) error {
	cfg.AccessToken = token.AccessToken
	cfg.RefreshToken = token.RefreshToken
	cfg.TokenExpiresAt = time.Now().Add(time.Duration(token.ExpiresIn) * time.Second)
	cfg.Username = token.User.Email
	if cfg.Username == "" {
		cfg.Username = token.User.Name
	}
	cfg.OrgID = token.User.OrgID
	cfg.OrgSlug = token.User.OrgSlug
	cfg.Role = token.User.Role
	return cfg.Save()
}

// RefreshIfNeeded checks whether the stored access token expires within 60
// seconds and refreshes it if so. It is a no-op when the token is still valid.
func RefreshIfNeeded(cfg *config.Config) error {
	if cfg.RefreshToken == "" {
		return fmt.Errorf("no refresh token available")
	}

	// Refresh when the access token is missing or within 60s of expiry.
	if cfg.AccessToken != "" && time.Now().Add(60*time.Second).Before(cfg.TokenExpiresAt) {
		return nil
	}

	body, err := json.Marshal(map[string]string{
		"refreshToken": cfg.RefreshToken,
	})
	if err != nil {
		return err
	}

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Post(
		cfg.ServerURL+"/api/auth/refresh",
		"application/json",
		bytes.NewReader(body),
	)
	if err != nil {
		return fmt.Errorf("token refresh request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("token refresh: HTTP %d", resp.StatusCode)
	}

	var envelope struct {
		Success bool `json:"success"`
		Data    struct {
			AccessToken  string `json:"accessToken"`
			RefreshToken string `json:"refreshToken"`
			ExpiresIn    int    `json:"expiresIn"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		return fmt.Errorf("decode refresh response: %w", err)
	}
	if !envelope.Success {
		return fmt.Errorf("token refresh: server returned failure")
	}

	cfg.AccessToken = envelope.Data.AccessToken
	if envelope.Data.RefreshToken != "" {
		cfg.RefreshToken = envelope.Data.RefreshToken
	}
	cfg.TokenExpiresAt = time.Now().Add(time.Duration(envelope.Data.ExpiresIn) * time.Second)

	return cfg.Save()
}
