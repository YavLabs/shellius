package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// Command is a registered slash command.
type Command struct {
	Name string // e.g. "/servers"
	Desc string // short description shown in palette
	Run  func(*AppModel) tea.Cmd
}

// builtinCommands is the registry of all available slash commands.
// Commands are looked up by fuzzy prefix on Name.
var builtinCommands = []Command{
	{
		Name: "/help",
		Desc: "Show key bindings and command reference",
		Run: func(app *AppModel) tea.Cmd {
			return func() tea.Msg { return showHelpMsg{} }
		},
	},
	{
		Name: "/servers",
		Desc: "Browse all servers (not just active access)",
		Run: func(app *AppModel) tea.Cmd {
			return func() tea.Msg { return openHostListMsg{} }
		},
	},
	{
		Name: "/request",
		Desc: "Submit a new access request for a server",
		Run: func(app *AppModel) tea.Cmd {
			return func() tea.Msg { return openRequestMsg{} }
		},
	},
	{
		Name: "/myrequests",
		Desc: "View all my access requests across statuses",
		Run: func(app *AppModel) tea.Cmd {
			return func() tea.Msg { return openMyRequestsMsg{} }
		},
	},
	{
		Name: "/sessions",
		Desc: "Active and recent SSH sessions",
		Run: func(app *AppModel) tea.Cmd {
			return func() tea.Msg { return showSessionsMsg{} }
		},
	},
	{
		Name: "/refresh",
		Desc: "Force refresh the active access list",
		Run: func(app *AppModel) tea.Cmd {
			return func() tea.Msg { return forceRefreshMsg{} }
		},
	},
	{
		Name: "/profile",
		Desc: "Show identity, token expiry, and server URL",
		Run: func(app *AppModel) tea.Cmd {
			return func() tea.Msg { return showProfileMsg{} }
		},
	},
	{
		Name: "/logout",
		Desc: "Clear credentials and exit",
		Run: func(app *AppModel) tea.Cmd {
			if err := app.cfg.Clear(); err != nil {
				return func() tea.Msg { return appErrMsg{err: err} }
			}
			return tea.Quit
		},
	},
	{
		Name: "/quit",
		Desc: "Exit shellius",
		Run: func(app *AppModel) tea.Cmd {
			return tea.Quit
		},
	},
}

// Navigation messages produced by command Run functions.
type showHelpMsg struct{}
type openHostListMsg struct{}
type openRequestMsg struct{}
type openMyRequestsMsg struct{}
type showSessionsMsg struct{}
type forceRefreshMsg struct{}
type showProfileMsg struct{}

// paletteModel is the slash-command palette overlay.
// It is shown on top of the current view when the user presses /.
type paletteModel struct {
	input    textinput.Model
	commands []Command // filtered subset
	cursor   int
	active   bool
	width    int
}

// newPaletteModel creates an idle palette (not yet visible).
func newPaletteModel() paletteModel {
	ti := textinput.New()
	ti.Placeholder = "command..."
	ti.CharLimit = 64
	ti.Width = 32
	ti.Prompt = "/ "

	return paletteModel{
		input:    ti,
		commands: builtinCommands,
	}
}

// Open activates the palette overlay with the given initial query.
// query should be the text typed after / (may be empty).
func (p paletteModel) Open(query string) paletteModel {
	p.active = true
	p.cursor = 0
	p.input.SetValue(query)
	p.input.Focus()
	p.input.CursorEnd()
	p.applyFilter()
	return p
}

// Close deactivates the palette.
func (p paletteModel) Close() paletteModel {
	p.active = false
	p.input.Blur()
	p.input.SetValue("")
	p.commands = builtinCommands
	p.cursor = 0
	return p
}

// Active reports whether the palette is currently visible.
func (p paletteModel) Active() bool { return p.active }

func (p *paletteModel) applyFilter() {
	q := strings.ToLower(strings.TrimSpace(p.input.Value()))
	if q == "" {
		p.commands = builtinCommands
		return
	}
	// Match by prefix of the command name (after the /) first, then fuzzy.
	var out []Command
	for _, c := range builtinCommands {
		nameBody := strings.TrimPrefix(strings.ToLower(c.Name), "/")
		if strings.HasPrefix(nameBody, q) || strings.HasPrefix(strings.ToLower(c.Name), q) {
			out = append(out, c)
			continue
		}
		// Fall back to fuzzy on name + desc.
		hay := strings.ToLower(c.Name + " " + c.Desc)
		if fuzzyMatch(q, hay) {
			out = append(out, c)
		}
	}
	p.commands = out
}

func (p paletteModel) Update(msg tea.Msg) (paletteModel, tea.Cmd) {
	if !p.active {
		return p, nil
	}

	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "esc":
			p = p.Close()
			return p, nil

		case "up", "k":
			if p.cursor > 0 {
				p.cursor--
			}
			return p, nil

		case "down", "j":
			if p.cursor < len(p.commands)-1 {
				p.cursor++
			}
			return p, nil

		case "enter":
			// Handled by the parent (AppModel) which calls SelectedCommand().
			return p, nil
		}
	}

	// Delegate to text input.
	var cmd tea.Cmd
	p.input, cmd = p.input.Update(msg)
	p.applyFilter()
	if p.cursor >= len(p.commands) {
		p.cursor = max(0, len(p.commands)-1)
	}
	return p, cmd
}

// SelectedCommand returns the currently highlighted command, or nil if none.
func (p paletteModel) SelectedCommand() *Command {
	if len(p.commands) == 0 || p.cursor >= len(p.commands) {
		return nil
	}
	c := p.commands[p.cursor]
	return &c
}

// View renders the palette as an overlay string.
// The caller is responsible for placing it in the layout.
func (p paletteModel) View() string {
	if !p.active {
		return ""
	}

	width := p.width
	if width < 50 {
		width = 50
	}
	if width > 70 {
		width = 70
	}

	var b strings.Builder

	// Input line.
	b.WriteString(p.input.View())
	b.WriteString("\n")

	if len(p.commands) == 0 {
		b.WriteString(MutedStyle.Render("  no matching commands"))
		b.WriteString("\n")
	} else {
		// Sliding window: keep the cursor inside the visible range so the
		// user can actually navigate to the last command. Previously the
		// render hard-sliced [0:maxShow] which left "/quit" forever hidden
		// behind a "… 1 more" placeholder no matter where the cursor was.
		maxShow := 8
		start := 0
		if p.cursor >= maxShow {
			start = p.cursor - maxShow + 1
		}
		end := start + maxShow
		if end > len(p.commands) {
			end = len(p.commands)
		}
		if start > 0 {
			b.WriteString(MutedStyle.Render(fmt.Sprintf("  ↑ %d more\n", start)))
		}
		for i := start; i < end; i++ {
			c := p.commands[i]
			selected := i == p.cursor

			// On selected rows the row background is coral, so the command
			// name (normally coral) and description (normally muted gray)
			// would render coral-on-coral and muted-on-coral, both nearly
			// invisible. Use uniform white text on selected rows so the
			// cursor is unambiguously legible.
			nameFg := colorAccent
			descFg := colorMuted
			if selected {
				nameFg = colorText
				descFg = colorText
			}
			nameStyle := lipgloss.NewStyle().
				Bold(true).
				Foreground(lipgloss.Color(nameFg)).
				Width(14)
			descStyle := lipgloss.NewStyle().
				Foreground(lipgloss.Color(descFg))

			row := nameStyle.Render(c.Name) + "  " + descStyle.Render(c.Desc)

			if selected {
				b.WriteString(renderSelectedRow(row, width-2))
			} else {
				b.WriteString(" " + row)
			}
			b.WriteString("\n")
		}
		if end < len(p.commands) {
			b.WriteString(MutedStyle.Render(fmt.Sprintf("  ↓ %d more\n", len(p.commands)-end)))
		}
	}

	b.WriteString(MutedStyle.Render("  esc cancel  ↑↓ select  enter run"))

	return PaletteStyle.Width(width).Render(b.String())
}
