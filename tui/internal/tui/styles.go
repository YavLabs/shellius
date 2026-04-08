package tui

import "github.com/charmbracelet/lipgloss"

// Color palette — Phase 22 redesign.
// Two accents only: emerald for selected/active, red for prod/warning.
// Everything else is dim gray.
const (
	colorAccent  = "#10b981" // emerald — selected, active access
	colorProd    = "#ef4444" // red — prod env badge, error states
	colorStaging = "#f59e0b" // amber — staging env badge
	colorDev     = "#22c55e" // green — dev / demo env badge
	colorDemo    = "#22c55e" // green — same as dev

	colorBorder    = "#374151" // outer border
	colorMuted     = "#6b7280" // help text, secondary info
	colorSubtle    = "#9ca3af" // slightly brighter secondary
	colorText      = "#f9fafb" // primary text
	colorHighlight = "#065f46" // emerald background for selected rows
	colorSurface   = "#111827" // slight surface tint (unused in outer border model)

	// Legacy aliases kept so existing callers compile without change.
	colorBg = colorSurface
)

// EnvBadge returns a short styled environment label.
// Labels are intentionally short: PROD, STG, DEV, DEMO.
func EnvBadge(env string) string {
	switch env {
	case "prod":
		return lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorProd)).
			Render("PROD")
	case "staging":
		return lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorStaging)).
			Render("STG")
	case "dev":
		return lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorDev)).
			Render("DEV")
	case "demo":
		return lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorDemo)).
			Render("DEMO")
	default:
		return lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorMuted)).
			Render(env)
	}
}

// AccessStatusStyle returns a styled string for the access status (host list).
func AccessStatusStyle(status string) string {
	switch status {
	case "direct":
		return lipgloss.NewStyle().Foreground(lipgloss.Color(colorAccent)).Render("ready")
	case "requires_approval":
		return lipgloss.NewStyle().Foreground(lipgloss.Color(colorStaging)).Render("needs approval")
	case "approved":
		return lipgloss.NewStyle().Foreground(lipgloss.Color(colorAccent)).Render("approved")
	default:
		return MutedStyle.Render(status)
	}
}

// Layout / component styles.
var (
	// AppStyle is the outer rounded border framing the whole application.
	// Sub-views render plain strings; only AppModel wraps with this border.
	AppStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color(colorBorder)).
			Padding(0, 1)

	TitleStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorAccent))

	SubtitleStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorSubtle))

	ErrorStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorProd))

	SuccessStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorAccent))

	MutedStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorMuted))

	// HighlightStyle is used for selected rows.
	HighlightStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorText)).
			Background(lipgloss.Color(colorHighlight)).
			Padding(0, 1)

	CodeStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorAccent))

	// BorderStyle is kept for sub-overlays (palette, etc.) that need their own frame.
	BorderStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color(colorBorder)).
			Padding(0, 1)

	// StatusBarStyle — one-line header, no background fill.
	StatusBarStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorSubtle))

	HelpBarStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorMuted))

	SectionHeaderStyle = lipgloss.NewStyle().
				Bold(true).
				Foreground(lipgloss.Color(colorMuted))

	InputLabelStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorSubtle))

	FocusedInputStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color(colorAccent))

	ListItemStyle = lipgloss.NewStyle().
			PaddingLeft(2)

	SelectedItemStyle = lipgloss.NewStyle().
				Bold(true).
				Foreground(lipgloss.Color(colorText)).
				Background(lipgloss.Color(colorHighlight)).
				PaddingLeft(2)

	// ToastStyle renders non-destructive warning banners.
	ToastStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorStaging))

	// PaletteStyle frames the command-palette overlay.
	PaletteStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color(colorBorder)).
			Padding(0, 1)

	// PaletteItemSelected highlights the active command in the palette.
	PaletteItemSelected = lipgloss.NewStyle().
				Bold(true).
				Foreground(lipgloss.Color(colorText)).
				Background(lipgloss.Color(colorHighlight)).
				PaddingLeft(1)

	PaletteItemNormal = lipgloss.NewStyle().
				PaddingLeft(1)
)
