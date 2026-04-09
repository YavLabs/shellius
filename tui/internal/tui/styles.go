package tui

import "github.com/charmbracelet/lipgloss"

// Color palette — centralized. All hex strings live here; views import named constants.
const (
	// Primary accent: warm coral — selection marker, spinner, section titles, app name.
	colorAccent = "#d97757"

	// Typography.
	colorPrimary = "#e6e6e6" // primary text (off-white)
	colorMuted   = "#8a8a8a" // secondary text, footer hints, metadata
	colorDim     = "#5a5a5a" // tertiary text, separator rules, bullets

	// Semantic.
	colorOK  = "#7eb87e" // approved / live
	colorWarn = "#d4b85a" // pending / warning
	colorErr  = "#cf6a6a" // denied / error

	// Environment badges — desaturated, not neon.
	colorEnvDev     = "#6e9aa6"
	colorEnvStaging = "#c0a060"
	colorEnvProd    = "#c47a7a"
	colorEnvDemo    = "#888888"

	// Legacy aliases — kept so existing code that references these compiles.
	// Do not add new references; use the canonical names above.
	colorText      = colorPrimary
	colorSubtle    = colorMuted
	colorBorder    = "#2a2a2a"
	colorSeparator = "#3a3a3a"
	colorHighlight = "#1a1a1a" // used in login.go user-code block background
	colorSurface   = "#0f0f0f"
	colorBg        = colorSurface

	// Kept for old badge references inside styles.go only.
	colorProd    = colorEnvProd
	colorStaging = colorEnvStaging
	colorDev     = colorEnvDev
	colorDemo    = colorEnvDemo

	// Selection marker.
	colorSelectMarker = colorAccent
)

// EnvBadge returns the lowercase env name in its color, width-padded to 8 chars.
// No box, no all-caps — just a colored label.
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
		label = "unknown"
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

// SelectionMarker is the left-edge marker for the selected row.
const SelectionMarker = "▎ "

// Layout / component styles.
var (
	// AppStyle: NO outer border. Left margin only.
	AppStyle = lipgloss.NewStyle().PaddingLeft(2)

	// TitleStyle: bold, primary color — section titles, screen titles.
	TitleStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorPrimary))

	SubtitleStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorMuted))

	ErrorStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorErr))

	// SuccessStyle uses the accent coral.
	SuccessStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorAccent))

	MutedStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorMuted))

	DimStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorDim))

	// HighlightStyle: kept for backward compat with login.go user-code block.
	HighlightStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorPrimary)).
			Background(lipgloss.Color(colorHighlight)).
			Padding(0, 1)

	CodeStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorAccent))

	// BorderStyle for sub-overlays that need their own frame.
	BorderStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color(colorBorder)).
			Padding(0, 1)

	// StatusBarStyle — one-line header, dim.
	StatusBarStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorMuted))

	// HelpBarStyle — footer hints, dim.
	HelpBarStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorDim))

	// SectionHeaderStyle: bold primary — section titles like "Active Access (3)".
	SectionHeaderStyle = lipgloss.NewStyle().
				Bold(true).
				Foreground(lipgloss.Color(colorPrimary))

	InputLabelStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorMuted))

	// FocusedInputStyle: accent color for the focused field label.
	FocusedInputStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color(colorAccent))

	// ListItemStyle: normal row — small left padding (no marker).
	ListItemStyle = lipgloss.NewStyle().PaddingLeft(2)

	// SelectedItemStyle: bold, no background fill.
	SelectedItemStyle = lipgloss.NewStyle().
				Bold(true).
				Foreground(lipgloss.Color(colorPrimary))

	// ToastStyle: warning/info inline message.
	ToastStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorWarn))

	// PaletteStyle frames the command-palette overlay.
	PaletteStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color(colorBorder)).
			Padding(0, 1)

	PaletteItemSelected = lipgloss.NewStyle().
				Bold(true).
				Foreground(lipgloss.Color(colorAccent)).
				PaddingLeft(1)

	PaletteItemNormal = lipgloss.NewStyle().
				Foreground(lipgloss.Color(colorMuted)).
				PaddingLeft(1)

	// SeparatorStyle: very dim horizontal rule.
	SeparatorStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorDim))
)

// renderSelectedRow wraps a row with the accent-colored left marker + bold text.
// NO background fill, NO trailing hints.
func renderSelectedRow(content string) string {
	marker := lipgloss.NewStyle().
		Foreground(lipgloss.Color(colorAccent)).
		Render(SelectionMarker)
	return marker + SelectedItemStyle.Render(content)
}

// renderNormalRow wraps a row with the standard unselected left indent.
func renderNormalRow(content string) string {
	return ListItemStyle.Render(content)
}
