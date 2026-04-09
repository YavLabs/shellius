package auth

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/shellius/tui/internal/config"
	"github.com/shellius/tui/internal/logx"
)

// ErrSessionExpired is returned by RefreshIfNeeded when the refresh endpoint
// rejects the stored refresh token with HTTP 401. The caller should treat this
// as a non-recoverable session error and prompt the user to re-authenticate
// (e.g. by routing back to the login screen).
var ErrSessionExpired = errors.New("session expired: please run `shellius login` again")

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
// On success the new tokens (including any rotated refresh token) are always
// persisted to disk via cfg.Save().
func RefreshIfNeeded(cfg *config.Config) error {
	if cfg.RefreshToken == "" {
		return fmt.Errorf("no refresh token available")
	}

	// Refresh when the access token is missing or within 60s of expiry.
	if cfg.AccessToken != "" && time.Now().Add(60*time.Second).Before(cfg.TokenExpiresAt) {
		return nil
	}

	logx.Infof("auth: access token near/past expiry (expires=%s), attempting refresh", cfg.TokenExpiresAt.UTC().Format(time.RFC3339))

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
		logx.Warnf("auth: refresh HTTP request failed: %v", err)
		return fmt.Errorf("token refresh request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		// The refresh token was rejected by the server — it has been
		// rotated, revoked, or wiped by reuse detection. There is no
		// recovery path other than re-authenticating, so signal that
		// explicitly so the UI can route the user to the login screen
		// instead of dead-ending in a generic "network error".
		logx.Warnf("auth: refresh returned 401 — refresh token is invalid, user must re-login")
		return ErrSessionExpired
	}
	if resp.StatusCode != http.StatusOK {
		logx.Warnf("auth: refresh returned HTTP %d", resp.StatusCode)
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
		logx.Warnf("auth: decode refresh response: %v", err)
		return fmt.Errorf("decode refresh response: %w", err)
	}
	if !envelope.Success {
		logx.Warnf("auth: refresh: server returned success=false")
		return fmt.Errorf("token refresh: server returned failure")
	}

	cfg.AccessToken = envelope.Data.AccessToken
	// Always update the refresh token when the server rotates it. The backend
	// may rotate on every call; missing this update is the root cause of the
	// persistent-login bug tracked in task 22a.
	if envelope.Data.RefreshToken != "" {
		cfg.RefreshToken = envelope.Data.RefreshToken
	}
	newExpiry := time.Now().Add(time.Duration(envelope.Data.ExpiresIn) * time.Second)
	cfg.TokenExpiresAt = newExpiry

	// Always persist after a successful refresh, even when only the access
	// token changed, so the new tokenExpiresAt is durable across restarts.
	if saveErr := cfg.Save(); saveErr != nil {
		logx.Warnf("auth: refresh succeeded but config save failed: %v", saveErr)
		return fmt.Errorf("token refresh: save config: %w", saveErr)
	}
	logx.Infof("auth: refresh successful, new expiry=%s rotatedRefreshToken=%v",
		newExpiry.UTC().Format(time.RFC3339), envelope.Data.RefreshToken != "")
	return nil
}
