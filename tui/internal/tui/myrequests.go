package tui

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/shellius/tui/internal/api"
)

// myRequestsState tracks the loading state.
type myRequestsState int

const (
	myRequestsLoading myRequestsState = iota
	myRequestsReady
	myRequestsError
)

// myRequestsLoadedMsg carries the fetched requests.
type myRequestsLoadedMsg struct{ requests []api.AccessRequest }

// myRequestsErrMsg carries a fetch error.
type myRequestsErrMsg struct{ err error }

// myRequestsModel is a read-only list of all the user's access requests
// across all statuses. Accessible via /myrequests from the command palette.
type myRequestsModel struct {
	client   *api.Client
	state    myRequestsState
	requests []api.AccessRequest
	cursor   int
	spinner  spinner.Model
	errMsg   string
	width    int
	height   int
}

func newMyRequestsModel(client *api.Client) myRequestsModel {
	s := spinner.New()
	s.Spinner = spinner.Dot
	s.Style = lipgloss.NewStyle().Foreground(lipgloss.Color(colorAccent))
	return myRequestsModel{
		client:  client,
		state:   myRequestsLoading,
		spinner: s,
	}
}

func (m myRequestsModel) Init() tea.Cmd {
	return tea.Batch(m.spinner.Tick, m.fetchCmd())
}

func (m myRequestsModel) fetchCmd() tea.Cmd {
	client := m.client
	return func() tea.Msg {
		reqs, err := client.ListMyAccessRequests()
		if err != nil {
			return myRequestsErrMsg{err: err}
		}
		return myRequestsLoadedMsg{requests: reqs}
	}
}

func (m myRequestsModel) Update(msg tea.Msg) (myRequestsModel, tea.Cmd) {
	switch msg := msg.(type) {

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height

	case myRequestsLoadedMsg:
		m.requests = msg.requests
		m.state = myRequestsReady
		m.cursor = 0
		return m, nil

	case myRequestsErrMsg:
		m.state = myRequestsError
		m.errMsg = msg.err.Error()
		return m, nil

	case spinner.TickMsg:
		if m.state == myRequestsLoading {
			var cmd tea.Cmd
			m.spinner, cmd = m.spinner.Update(msg)
			return m, cmd
		}

	case tea.KeyMsg:
		switch msg.String() {
		case "esc", "q":
			return m, func() tea.Msg { return navBackMsg{} }

		case "up", "k":
			if m.cursor > 0 {
				m.cursor--
			}
			return m, nil

		case "down", "j":
			if m.cursor < len(m.requests)-1 {
				m.cursor++
			}
			return m, nil

		case "r", "ctrl+r":
			m.state = myRequestsLoading
			m.requests = nil
			m.cursor = 0
			return m, tea.Batch(m.spinner.Tick, m.fetchCmd())
		}
		return m, nil
	}

	return m, nil
}

func (m myRequestsModel) visibleRows() int {
	reserved := 8 // title + separator + header + footer + padding
	v := m.height - reserved
	if v < 3 {
		v = 3
	}
	return v
}

func (m myRequestsModel) View() string {
	var b strings.Builder

	// Section title.
	b.WriteString("  ")
	b.WriteString(SectionHeaderStyle.Render("My Access Requests"))
	b.WriteString(DimStyle.Render(fmt.Sprintf(" (%d)", len(m.requests))))
	b.WriteString("\n\n")

	switch m.state {
	case myRequestsLoading:
		b.WriteString("  ")
		b.WriteString(m.spinner.View())
		b.WriteString(" ")
		b.WriteString(MutedStyle.Render("loading requests..."))

	case myRequestsError:
		b.WriteString("  ")
		b.WriteString(ErrorStyle.Render("error: "))
		b.WriteString(MutedStyle.Render(m.errMsg))
		b.WriteString("\n  ")
		b.WriteString(HelpBarStyle.Render("r retry · esc back"))

	case myRequestsReady:
		if len(m.requests) == 0 {
			b.WriteString("  ")
			b.WriteString(MutedStyle.Render("no access requests — use /request to submit one"))
		} else {
			visible := m.visibleRows()
			start := 0
			if m.cursor >= visible {
				start = m.cursor - visible + 1
			}
			end := start + visible
			if end > len(m.requests) {
				end = len(m.requests)
			}

			for i := start; i < end; i++ {
				r := m.requests[i]
				selected := i == m.cursor
				b.WriteString(m.renderRow(r, selected))
				b.WriteString("\n")
			}

			if len(m.requests) > visible {
				info := fmt.Sprintf("  %d-%d of %d", start+1, end, len(m.requests))
				b.WriteString(DimStyle.Render(info))
				b.WriteString("\n")
			}
		}
	}

	return b.String()
}

func (m myRequestsModel) renderRow(r api.AccessRequest, selected bool) string {
	serverName := mrServerName(r)
	env := mrEnv(r)

	badge := EnvBadge(env)
	statusGlyph := StatusBadge(r.Status)

	nameCol := lipgloss.NewStyle().Width(22).
		Foreground(lipgloss.Color(colorText)).
		Render(serverName)
	principalCol := lipgloss.NewStyle().Width(12).
		Foreground(lipgloss.Color(colorMuted)).
		Render(r.RequestedPrincipal)

	// Age / expiry.
	var timeCol string
	switch r.Status {
	case "APPROVED":
		if r.ExpiresAt != nil {
			remaining := time.Until(*r.ExpiresAt)
			if remaining > 0 {
				timeCol = "expires " + formatDuration(remaining)
			} else {
				timeCol = "expired"
			}
		}
	case "PENDING":
		timeCol = formatDuration(time.Since(r.CreatedAt)) + " ago"
	default:
		if !r.CreatedAt.IsZero() {
			timeCol = r.CreatedAt.Local().Format("01-02 15:04")
		}
	}
	timeStr := lipgloss.NewStyle().Width(16).
		Foreground(lipgloss.Color(colorDim)).
		Render(timeCol)

	content := badge + "  " + nameCol + "  " + principalCol + "  " + statusGlyph + "  " + timeStr

	if selected {
		return renderSelectedRow(content)
	}
	return renderNormalRow(content)
}

func mrServerName(r api.AccessRequest) string {
	if r.Server != nil {
		if r.Server.DisplayName != "" {
			return r.Server.DisplayName
		}
		return r.Server.Hostname
	}
	return r.ServerID
}

func mrEnv(r api.AccessRequest) string {
	if r.Server != nil {
		return r.Server.Environment
	}
	return ""
}
