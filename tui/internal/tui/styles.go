package tui

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// Color palette — eight named constants.
// colorAccent is the coral identity color (replaces sshm's cyan).
const (
	colorAccent = "#d97757" // warm coral
	colorText   = "#e6e6e6" // default body text
	colorMuted  = "#8a8a8a" // secondary metadata
	colorDim    = "#5a5a5a" // tertiary
	colorOK     = "#7eb87e" // approved / live
	colorWarn   = "#d4b85a" // pending / stale
	colorErr    = "#cf6a6a" // denied / error
	colorBorder = "#3a3a3a" // panel / overlay borders

	// colorHighlight: ONLY used in login user-code background block.
	colorHighlight = "#1a1a1a"
)

// Environment colors.
const (
	colorEnvProd    = colorErr
	colorEnvStaging = colorWarn
	colorEnvDev     = "#6e9aa6"
	colorEnvDemo    = colorDim
)

// SelectionMarker is kept for palette compatibility.
const SelectionMarker = "▎ "

// EnvBadge returns the lowercase env name in its semantic color, width-padded to 8 chars.
func EnvBadge(env string) string { return envBadgeFg(env, "") }

// EnvBadgePlain returns the env name padded to 8 chars with NO foreground
// color applied. Used by selected list rows where the row's coral background
// would otherwise hide the env's semantic color.
func EnvBadgePlain(env string) string { return envBadgeFg(env, colorText) }

func envBadgeFg(env, override string) string {
	if env == "" {
		return "        "
	}
	col := override
	if col == "" {
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
	}
	return lipgloss.NewStyle().
		Foreground(lipgloss.Color(col)).
		Width(8).
		Render(env)
}

// StatusBadge returns a one-character glyph + color for request status.
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
		return lipgloss.NewStyle().Foreground(lipgloss.Color(colorOK)).Render("available")
	case "requires_approval":
		return lipgloss.NewStyle().Foreground(lipgloss.Color(colorWarn)).Render("requires approval")
	case "approved":
		return lipgloss.NewStyle().Foreground(lipgloss.Color(colorOK)).Render("approved")
	default:
		return lipgloss.NewStyle().Foreground(lipgloss.Color(colorMuted)).Render(status)
	}
}

// --- Base styles ---

var (
	TitleStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorText))

	SectionHeaderStyle = TitleStyle

	SubtitleStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorMuted))

	ErrorStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorErr))

	MutedStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorMuted))

	DimStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorDim))

	CodeStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorAccent))

	HelpBarStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorDim))

	InputLabelStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorMuted))

	FocusedInputStyle = lipgloss.NewStyle().
				Bold(true).
				Foreground(lipgloss.Color(colorAccent))

	HighlightStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorText)).
			Background(lipgloss.Color(colorHighlight)).
			Padding(0, 1)

	ToastStyle = lipgloss.NewStyle().
			Italic(true).
			Foreground(lipgloss.Color(colorWarn))

	// PaletteStyle: the rounded border frame for the command palette.
	PaletteStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color(colorBorder)).
			Padding(0, 1)

	SuccessStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colorAccent))

	// SelectedItemStyle: for content on a selected row.
	SelectedItemStyle = lipgloss.NewStyle().
				Bold(true).
				Foreground(lipgloss.Color(colorText))

	ListItemStyle = lipgloss.NewStyle().PaddingLeft(2)
)

// --- sshm-style panel helpers ---

// RoundedPanel wraps content in a rounded border panel using colorBorder.
// width is the total outer width (border included). Pass 0 for auto.
func RoundedPanel(content string, width int) string {
	s := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color(colorBorder)).
		Padding(0, 1)
	if width > 0 {
		s = s.Width(width - 2) // lipgloss width is inner
	}
	return s.Render(content)
}

// TableHeaderSep returns a dim horizontal rule for separating header from rows.
// width is the inner content width.
func TableHeaderSep(width int) string {
	if width < 1 {
		width = 1
	}
	return DimStyle.Render(strings.Repeat("─", width))
}

// TableHeaderStyle returns a style for column headers: accent + bold.
var TableHeaderStyle = lipgloss.NewStyle().
	Bold(true).
	Foreground(lipgloss.Color(colorAccent))

// renderSelectedRow fills the entire row with a coral background.
// content should be the full padded row string (no trailing newline).
func renderSelectedRow(content string, rowWidth int) string {
	s := lipgloss.NewStyle().
		Bold(true).
		Foreground(lipgloss.Color(colorText)).
		Background(lipgloss.Color(colorAccent))
	if rowWidth > 0 {
		s = s.Width(rowWidth)
	}
	return s.Render(content)
}

// renderNormalRow wraps an unselected row with a 1-space left indent inside the panel.
func renderNormalRow(content string) string {
	return " " + content
}

// SearchBarLabel renders the "Search (/ to focus): › " prefix in accent color.
func SearchBarLabel() string {
	return lipgloss.NewStyle().
		Foreground(lipgloss.Color(colorAccent)).
		Render("Search (/ to focus): › ")
}

// SortIndicator renders "Sort: ↓<field>" in muted gray.
func SortIndicator(field string) string {
	return DimStyle.Render("Sort: ↓" + field)
}

// FormFieldLabel renders a form field label. If focused, uses accent+bold.
// Required fields get a " *" suffix.
func FormFieldLabel(label string, focused bool, required bool) string {
	if required {
		label += " *"
	}
	if focused {
		return FocusedInputStyle.Render(label)
	}
	return InputLabelStyle.Render(label)
}

// FormInputBox wraps a textinput View() in a rounded border.
// focused controls whether to use the accent border color or dim.
func FormInputBox(inputView string, focused bool, width int) string {
	borderColor := colorBorder
	if focused {
		borderColor = colorAccent
	}
	s := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color(borderColor)).
		Padding(0, 1)
	if width > 0 {
		s = s.Width(width - 4) // account for border(2) + padding(2)
	}
	return s.Render(inputView)
}

// ShelliusLogo returns the ASCII art logo in coral (colorAccent).
// Returns empty string if termHeight < 28 (caller is responsible for this check).
func ShelliusLogo() string {
	// Block-letter "SHELLIUS" — 6 lines tall, ~46 chars wide.
	// Designed to fit in an 80-col terminal inside a bordered panel.
	lines := []string{
		" ███████╗██╗  ██╗███████╗██╗     ██╗     ██╗██╗   ██╗███████╗",
		" ██╔════╝██║  ██║██╔════╝██║     ██║     ██║██║   ██║██╔════╝",
		" ███████╗███████║█████╗  ██║     ██║     ██║██║   ██║███████╗",
		" ╚════██║██╔══██║██╔══╝  ██║     ██║     ██║██║   ██║╚════██║",
		" ███████║██║  ██║███████╗███████╗███████╗██║╚██████╔╝███████║",
		" ╚══════╝╚═╝  ╚═╝╚══════╝╚══════╝╚══════╝╚═╝ ╚═════╝ ╚══════╝",
	}
	style := lipgloss.NewStyle().Foreground(lipgloss.Color(colorAccent))
	var b strings.Builder
	for _, l := range lines {
		b.WriteString(style.Render(l))
		b.WriteString("\n")
	}
	return b.String()
}

// ShelliusLogoSmall returns a compact 3-line "SHL" mark for narrow contexts.
func ShelliusLogoSmall() string {
	lines := []string{
		" ███████╗██╗  ██╗██╗     ",
		" ██╔════╝██║  ██║██║     ",
		" ███████╗███████║███████╗",
	}
	style := lipgloss.NewStyle().Foreground(lipgloss.Color(colorAccent))
	var b strings.Builder
	for _, l := range lines {
		b.WriteString(style.Render(l))
		b.WriteString("\n")
	}
	return b.String()
}
