package auth

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// DeviceAuthResponse is the payload from POST /api/auth/device/authorize.
type DeviceAuthResponse struct {
	DeviceCode              string `json:"deviceCode"`
	UserCode                string `json:"userCode"`
	VerificationUri         string `json:"verificationUri"`
	VerificationUriComplete string `json:"verificationUriComplete"`
	ExpiresIn               int    `json:"expiresIn"`
	Interval                int    `json:"interval"`
}

// TokenResponse is the payload from POST /api/auth/device/poll on success.
type TokenResponse struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	ExpiresIn    int    `json:"expiresIn"`
	User         struct {
		ID       string `json:"id"`
		Email    string `json:"email"`
		Name     string `json:"name"`
		Role     string `json:"role"`
		OrgID    string `json:"orgId"`
		OrgSlug  string `json:"orgSlug"`
	} `json:"user"`
}

// authorizeRequest mirrors the backend's Joi schema.
type authorizeRequest struct {
	OrgSlug  string `json:"org_slug"`
	ClientID string `json:"client_id,omitempty"`
	Scope    string `json:"scope,omitempty"`
}

// pollRequest mirrors the backend's pollSchema.
type pollRequest struct {
	DeviceCode string `json:"device_code"`
}

// apiEnvelope is the standard Shellius response wrapper.
type apiEnvelope struct {
	Success bool            `json:"success"`
	Data    json.RawMessage `json:"data"`
	Error   string          `json:"error"`
}

// PollError is returned when the poll indicates a non-fatal pending state.
type PollError struct {
	Code string
}

func (e *PollError) Error() string {
	return fmt.Sprintf("device auth: %s", e.Code)
}

// IsAuthorizationPending returns true when the user has not yet approved.
func IsAuthorizationPending(err error) bool {
	if pe, ok := err.(*PollError); ok {
		return pe.Code == "authorization_pending"
	}
	return false
}

// IsSlowDown returns true when the server wants us to back off.
func IsSlowDown(err error) bool {
	if pe, ok := err.(*PollError); ok {
		return pe.Code == "slow_down"
	}
	return false
}

// IsExpired returns true when the device code has expired.
func IsExpired(err error) bool {
	if pe, ok := err.(*PollError); ok {
		return pe.Code == "expired"
	}
	return false
}

// StartDeviceFlow initiates the device authorization flow against the Shellius
// backend. orgSlug identifies the tenant. serverURL is e.g. "http://localhost:3000".
func StartDeviceFlow(serverURL, orgSlug string) (DeviceAuthResponse, error) {
	body, err := json.Marshal(authorizeRequest{
		OrgSlug:  orgSlug,
		ClientID: "shellius-tui",
	})
	if err != nil {
		return DeviceAuthResponse{}, err
	}

	resp, err := http.Post(
		serverURL+"/api/auth/device/authorize",
		"application/json",
		bytes.NewReader(body),
	)
	if err != nil {
		return DeviceAuthResponse{}, fmt.Errorf("device authorize request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return DeviceAuthResponse{}, fmt.Errorf("device authorize: HTTP %d", resp.StatusCode)
	}

	// The /authorize endpoint returns the data inline (no success wrapper per the route).
	var result DeviceAuthResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return DeviceAuthResponse{}, fmt.Errorf("decode device authorize response: %w", err)
	}
	return result, nil
}

// PollForToken polls /api/auth/device/poll until the user approves, denies,
// or the code expires. interval is the initial polling interval in seconds.
// On slow_down the interval is doubled. Returns a TokenResponse on success.
func PollForToken(serverURL, deviceCode string, interval int) (TokenResponse, error) {
	if interval <= 0 {
		interval = 5
	}
	client := &http.Client{Timeout: 15 * time.Second}

	for {
		time.Sleep(time.Duration(interval) * time.Second)

		body, err := json.Marshal(pollRequest{DeviceCode: deviceCode})
		if err != nil {
			return TokenResponse{}, err
		}

		resp, err := client.Post(
			serverURL+"/api/auth/device/poll",
			"application/json",
			bytes.NewReader(body),
		)
		if err != nil {
			return TokenResponse{}, fmt.Errorf("poll request: %w", err)
		}

		var envelope apiEnvelope
		if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
			resp.Body.Close()
			return TokenResponse{}, fmt.Errorf("decode poll response: %w", err)
		}
		resp.Body.Close()

		if !envelope.Success {
			// Map error codes to PollError so callers can inspect them.
			var errDetail struct {
				Code string `json:"code"`
			}
			// The error field may be a plain string from the backend.
			code := string(envelope.Error)
			if len(envelope.Data) > 0 {
				_ = json.Unmarshal(envelope.Data, &errDetail)
				if errDetail.Code != "" {
					code = errDetail.Code
				}
			}
			// Normalise common code strings the backend may send.
			switch code {
			case "authorization_pending", `"authorization_pending"`:
				return TokenResponse{}, &PollError{Code: "authorization_pending"}
			case "slow_down", `"slow_down"`:
				interval *= 2
				if interval > 30 {
					interval = 30
				}
				return TokenResponse{}, &PollError{Code: "slow_down"}
			case "expired", `"expired"`:
				return TokenResponse{}, &PollError{Code: "expired"}
			default:
				return TokenResponse{}, &PollError{Code: code}
			}
		}

		var token TokenResponse
		if err := json.Unmarshal(envelope.Data, &token); err != nil {
			return TokenResponse{}, fmt.Errorf("decode token data: %w", err)
		}
		return token, nil
	}
}
