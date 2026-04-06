package tui

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
	"github.com/shellius/tui/internal/config"
)

// StatusBar renders a one-line status bar showing the authenticated user,
// server URL, and token expiry countdown.
type StatusBar struct {
	cfg   *config.Config
	width int
}

// NewStatusBar creates a StatusBar for the given config.
func NewStatusBar(cfg *config.Config) *StatusBar {
	return &StatusBar{cfg: cfg}
}

// SetWidth updates the terminal width used for layout.
func (sb *StatusBar) SetWidth(w int) {
	sb.width = w
}

// View renders the status bar.
func (sb *StatusBar) View() string {
	left := sb.leftSection()
	right := sb.rightSection()

	// Pad middle space to fill the full width.
	leftWidth := lipgloss.Width(left)
	rightWidth := lipgloss.Width(right)
	gap := sb.width - leftWidth - rightWidth
	if gap < 1 {
		gap = 1
	}
	middle := strings.Repeat(" ", gap)

	bar := StatusBarStyle.Width(sb.width).Render(left + middle + right)
	return bar
}

func (sb *StatusBar) leftSection() string {
	if sb.cfg == nil || sb.cfg.Username == "" {
		return MutedStyle.Render("not logged in")
	}
	user := lipgloss.NewStyle().
		Foreground(lipgloss.Color(colorAccent)).
		Bold(true).
		Render(sb.cfg.Username)

	org := ""
	if sb.cfg.OrgSlug != "" {
		org = MutedStyle.Render(" @ " + sb.cfg.OrgSlug)
	}

	url := MutedStyle.Render("  " + sb.cfg.ServerURL)
	return user + org + url
}

func (sb *StatusBar) rightSection() string {
	if sb.cfg == nil || sb.cfg.AccessToken == "" {
		return ""
	}

	remaining := time.Until(sb.cfg.TokenExpiresAt)
	if remaining <= 0 {
		return ErrorStyle.Render("token expired")
	}

	var countdown string
	switch {
	case remaining > time.Hour:
		h := int(remaining.Hours())
		countdown = fmt.Sprintf("%dh", h)
	case remaining > time.Minute:
		m := int(remaining.Minutes())
		countdown = fmt.Sprintf("%dm", m)
	default:
		s := int(remaining.Seconds())
		countdown = fmt.Sprintf("%ds", s)
		return lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorProd)).
			Render("token expires in " + countdown)
	}

	return MutedStyle.Render("token: " + countdown)
}
