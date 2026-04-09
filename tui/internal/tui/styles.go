package tui

import "github.com/charmbracelet/lipgloss"

// Color palette — eight named constants, section B of the spec.
// All hex strings live here; all views import by name.
const (
	// colorAccent: warm coral — selection marker ▎, focused field label,
	// wordmark "shellius", login user-code, request-ID code blocks.
	colorAccent = "#d97757"

	// colorText: default body text, primary list-item names, bold titles.
	colorText = "#e6e6e6"

	// colorMuted: secondary metadata — principal, customer name, footer hints.
	colorMuted = "#8a8a8a"

	// colorDim: tertiary — customer group headers, count parens, scroll indicator.
	colorDim = "#5a5a5a"

	// colorOK: approved status glyph, live session, success state.
	colorOK = "#7eb87e"

	// colorWarn: pending status glyph, stale-cache hint, toast.
	colorWarn = "#d4b85a"

	// colorErr: denied/error status glyph, validation errors, error screen.
	colorErr = "#cf6a6a"

	// colorBorder: palette overlay border — the ONLY place a border is drawn.
	colorBorder = "#2a2a2a"

	// colorHighlight: used ONLY in login.go user-code background block.
	// This is the one background fill in the whole TUI and it earns its place.
	colorHighlight = "#1a1a1a"
)

// Environment colors (three reusable semantic + one extra for dev).
// These are not in the named-8 because they are not global — used only in EnvBadge.
const (
	colorEnvProd    = colorErr  // prod → red
	colorEnvStaging = colorWarn // staging → yellow
	colorEnvDev     = "#6e9aa6" // dev → cool slate (the one extra hue)
	colorEnvDemo    = colorDim  // demo → dim
)

// SelectionMarker is the left-edge marker for the selected row (U+258E + space).
const SelectionMarker = "▎ "

// EnvBadge returns the lowercase env name in its color, width-padded to 8 chars.
// No box, no ALL-CAPS — just a colored label. Empty env renders as 8 spaces.
func EnvBadge(env string) string {
	var col string
	switch env {
	case "prod":
		col = colorEnvProd
	case "staging":
		col = colorEnvStaging
	case "dev":
		col = colorEnvDev
	case "demo":
		col = colorEnvDemo
	default:
		col = colorDim
	}
	label := env
	if label == "" {
		// Render eight spaces so the column still lines up, but "unknown"
		// doesn't appear — silence is less intrusive than a wrong label.
		return "        "
	}
	return lipgloss.NewStyle().
		Foreground(lipgloss.Color(col)).
		Width(8).
		Render(label)
}

// StatusBadge returns a one-character glyph + color for request status.
// No boxed pill — just a colored symbol.
func StatusBadge(status string) string {
	switch status {
	case "APPROVED":
		return lipgloss.NewStyle().Foreground(lipgloss.Color(colorOK)).Render("●")
	case "PENDING":
		return lipgloss.NewStyle().Foreground(lipgloss.Color(colorWarn)).Render("○")
	case "DENIED":
		return lipgloss.NewStyle().Foreground(lipgloss.Color(colorErr)).Render("✗")
	case "EXPIRED":
		return lipgloss.NewStyle().Foreground(lipgloss.Color(colorDim)).Render("·")
	case "REVOKED":
		return lipgloss.NewStyle().Foreground(lipgloss.Color(colorDim)).Render("⊘")
	default:
		return lipgloss.NewStyle().Foreground(lipgloss.Color(colorMuted)).Render("?")
	}
}

// AccessStatusStyle returns a styled string for host access status.
func AccessStatusStyle(status string) string {
	switch status {
	case "direct":
		return lipgloss.NewStyle().Foreground(lipgloss.Color(colorOK)).Render("ready")
	case "requires_approval":
		return lipgloss.NewStyle().Foreground(lipgloss.Color(colorWarn)).Render("needs approval")
	case "approved":
		return lipgloss.NewStyle().Foreground(lipgloss.Color(colorOK)).Render("approved")
	default:
		return lipgloss.NewStyle().Foreground(lipgloss.Color(colorMuted)).Render(status)
	}
}

// --- Shared component styles ---

var (
	// TitleStyle: bold + colorText — section titles, screen titles.
	TitleStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorText))

	// SectionHeaderStyle: same as TitleStyle; alias for clarity at call sites.
	SectionHeaderStyle = TitleStyle

	// SubtitleStyle: dim subtitle under the wordmark on login.
	SubtitleStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorMuted))

	// ErrorStyle: bold colorErr — "Error" prefix word.
	ErrorStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorErr))

	// MutedStyle: regular colorMuted — metadata, descriptions.
	MutedStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorMuted))

	// DimStyle: regular colorDim — tertiary info, scroll indicators.
	DimStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorDim))

	// CodeStyle: bold colorAccent — request IDs, user codes, URLs.
	CodeStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorAccent))

	// HelpBarStyle: footer hints, dim regular.
	HelpBarStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorDim))

	// InputLabelStyle: field label — muted normally.
	InputLabelStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorMuted))

	// FocusedInputStyle: field label — accent + bold when focused.
	FocusedInputStyle = lipgloss.NewStyle().
				Bold(true).
				Foreground(lipgloss.Color(colorAccent))

	// HighlightStyle: used ONLY in login.go user-code block background.
	HighlightStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorText)).
			Background(lipgloss.Color(colorHighlight)).
			Padding(0, 1)

	// ToastStyle: one-line warning/info message — muted, no decoration.
	ToastStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorWarn))

	// PaletteStyle: the rounded border frame for the command palette.
	// This is the ONLY border drawn in the entire TUI.
	PaletteStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color(colorBorder)).
			Padding(0, 1)

	// SuccessStyle: accent for success messages (login OK, approved).
	SuccessStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorAccent))

	// SelectedItemStyle: bold + colorText for selected row content.
	SelectedItemStyle = lipgloss.NewStyle().
				Bold(true).
				Foreground(lipgloss.Color(colorText))

	// ListItemStyle: unselected row — 2-space left indent (marker replaced by spaces).
	ListItemStyle = lipgloss.NewStyle().PaddingLeft(2)
)

// renderSelectedRow wraps a row with the accent-colored left marker + bold text.
// No background fill, no trailing hints. 2-space margin is provided by the marker.
func renderSelectedRow(content string) string {
	marker := lipgloss.NewStyle().
		Foreground(lipgloss.Color(colorAccent)).
		Render(SelectionMarker)
	return marker + SelectedItemStyle.Render(content)
}

// renderNormalRow wraps a row with the standard unselected left indent (2 spaces).
func renderNormalRow(content string) string {
	return ListItemStyle.Render(content)
}
