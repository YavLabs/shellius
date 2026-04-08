package tui

import "github.com/charmbracelet/lipgloss"

// Color palette
const (
	colorAccent  = "#14b8a6" // teal
	colorProd    = "#ef4444" // red
	colorStaging = "#f59e0b" // amber
	colorDev     = "#22c55e" // green
	colorDemo    = "#3b82f6" // blue

	colorBg        = "#0f172a"
	colorSurface   = "#1e293b"
	colorBorder    = "#334155"
	colorText      = "#f1f5f9"
	colorMuted     = "#64748b"
	colorSubtle    = "#94a3b8"
	colorHighlight = "#0f766e"
)

// Badge styles — environment badges.
var (
	BadgeProd = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorProd)).
			Background(lipgloss.Color("#450a0a")).
			Padding(0, 1).
			SetString("[PROD]")

	BadgeStaging = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorStaging)).
			Background(lipgloss.Color("#451a03")).
			Padding(0, 1).
			SetString("[STAGING]")

	BadgeDev = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorDev)).
			Background(lipgloss.Color("#052e16")).
			Padding(0, 1).
			SetString("[DEV]")

	BadgeDemo = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorDemo)).
			Background(lipgloss.Color("#172554")).
			Padding(0, 1).
			SetString("[DEMO]")
)

// Layout styles
var (
	AppStyle = lipgloss.NewStyle().
			Padding(0, 1)

	TitleStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorAccent)).
			MarginBottom(1)

	SubtitleStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorSubtle))

	ErrorStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorProd))

	SuccessStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorDev))

	MutedStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorMuted))

	HighlightStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorText)).
			Background(lipgloss.Color(colorHighlight)).
			Padding(0, 1)

	CodeStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorAccent)).
			Background(lipgloss.Color(colorSurface)).
			Padding(0, 1)

	BorderStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color(colorBorder)).
			Padding(1, 2)

	StatusBarStyle = lipgloss.NewStyle().
			Background(lipgloss.Color(colorSurface)).
			Foreground(lipgloss.Color(colorSubtle)).
			Padding(0, 1)

	HelpBarStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorMuted)).
			MarginTop(1)

	SectionHeaderStyle = lipgloss.NewStyle().
				Bold(true).
				Foreground(lipgloss.Color(colorAccent)).
				MarginTop(1)

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

	// ToastStyle renders non-destructive warning banners (e.g. refresh failure).
	ToastStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorStaging)).
			Background(lipgloss.Color("#451a03")).
			Padding(0, 1).
			MarginBottom(1)
)

// EnvBadge returns the appropriate styled badge string for a given environment.
func EnvBadge(env string) string {
	switch env {
	case "prod":
		return BadgeProd.String()
	case "staging":
		return BadgeStaging.String()
	case "dev":
		return BadgeDev.String()
	case "demo":
		return BadgeDemo.String()
	default:
		return MutedStyle.Render("[" + env + "]")
	}
}

// AccessStatusStyle returns a styled string for the access status.
func AccessStatusStyle(status string) string {
	switch status {
	case "direct":
		return SuccessStyle.Render("ready")
	case "requires_approval":
		return lipgloss.NewStyle().Foreground(lipgloss.Color(colorStaging)).Render("approval required")
	case "approved":
		return SuccessStyle.Render("approved")
	default:
		return MutedStyle.Render(status)
	}
}
