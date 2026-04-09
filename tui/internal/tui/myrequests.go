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

// myRequestsModel is a read-only list of all the user's access requests.
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

		case "g":
			m.cursor = 0
			return m, nil

		case "G":
			if len(m.requests) > 0 {
				m.cursor = len(m.requests) - 1
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
	// Reserve: search(1) + sort(1) + blank(1) + colheader(1) + sep(1) + count(1) +
	//          border(2) + app-header(2) + app-footer(1) = 11
	reserved := 11
	v := m.height - reserved
	if v < 3 {
		v = 3
	}
	return v
}

func (m myRequestsModel) innerWidth() int {
	w := m.width - 4
	if w < 56 {
		w = 56
	}
	if w > 116 {
		w = 116
	}
	return w
}

func (m myRequestsModel) View() string {
	iw := m.innerWidth()
	var bodyLines []string

	// No search bar for myrequests — just sort indicator
	bodyLines = append(bodyLines, SortIndicator("submitted"))
	bodyLines = append(bodyLines, "")

	switch m.state {
	case myRequestsLoading:
		bodyLines = append(bodyLines,
			m.spinner.View()+" "+MutedStyle.Render("loading requests..."),
		)

	case myRequestsError:
		bodyLines = append(bodyLines,
			ErrorStyle.Render("error: ")+MutedStyle.Render(m.errMsg),
			HelpBarStyle.Render("r retry · esc back"),
		)

	case myRequestsReady:
		// Column headers
		bodyLines = append(bodyLines, m.renderHeaderRow(iw))
		bodyLines = append(bodyLines, TableHeaderSep(iw))

		if len(m.requests) == 0 {
			bodyLines = append(bodyLines, MutedStyle.Render("no access requests — use /request to submit one"))
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
				bodyLines = append(bodyLines, m.renderRow(r, i == m.cursor, iw))
			}

			if len(m.requests) > visible {
				info := fmt.Sprintf("%d-%d of %d", start+1, end, len(m.requests))
				bodyLines = append(bodyLines, DimStyle.Render(info))
			}
		}

		countStr := fmt.Sprintf("%d request", len(m.requests))
		if len(m.requests) != 1 {
			countStr = fmt.Sprintf("%d requests", len(m.requests))
		}
		bodyLines = append(bodyLines, "")
		bodyLines = append(bodyLines, DimStyle.Render(countStr))
	}

	body := strings.Join(bodyLines, "\n")
	panelWidth := m.width - 4
	if panelWidth < 56 {
		panelWidth = 56
	}
	if panelWidth > 116 {
		panelWidth = 116
	}
	return RoundedPanel(body, panelWidth)
}

func (m myRequestsModel) renderHeaderRow(iw int) string {
	status := TableHeaderStyle.Width(10).Render("Status")
	env := TableHeaderStyle.Width(8).Render("Env")
	server := TableHeaderStyle.Width(20).Render("Server")
	principal := TableHeaderStyle.Width(12).Render("Principal")
	submitted := TableHeaderStyle.Width(14).Render("Submitted")
	note := TableHeaderStyle.Render("Expires/Reason")
	_ = iw
	return status + " " + env + " " + server + " " + principal + " " + submitted + " " + note
}

func (m myRequestsModel) renderRow(r api.AccessRequest, selected bool, iw int) string {
	// Status: glyph + text
	glyph := StatusBadge(r.Status)
	statusText := lipgloss.NewStyle().Width(8).Foreground(lipgloss.Color(colorMuted)).Render(statusLabel(r.Status))
	statusCol := glyph + " " + statusText

	env := mrEnv(r)
	envCol := EnvBadge(env)

	serverName := mrServerName(r)
	serverCol := lipgloss.NewStyle().Width(20).Foreground(lipgloss.Color(colorText)).Render(truncate(serverName, 19))

	principalCol := lipgloss.NewStyle().Width(12).Foreground(lipgloss.Color(colorMuted)).Render(truncate(r.RequestedPrincipal, 11))

	// Submitted time
	var submittedStr string
	if !r.CreatedAt.IsZero() {
		submittedStr = r.CreatedAt.Local().Format("01-02 15:04")
	}
	submittedCol := lipgloss.NewStyle().Width(14).Foreground(lipgloss.Color(colorDim)).Render(submittedStr)

	// Expires / reason column
	var noteStr string
	switch r.Status {
	case "APPROVED":
		if r.ExpiresAt != nil {
			remaining := time.Until(*r.ExpiresAt)
			if remaining > 0 {
				noteStr = "expires " + formatDuration(remaining)
			} else {
				noteStr = "expired"
			}
		}
	case "PENDING":
		noteStr = formatDuration(time.Since(r.CreatedAt)) + " ago"
	case "DENIED":
		if r.DeniedReason != "" {
			noteStr = truncate(r.DeniedReason, 24)
		}
	}
	noteCol := lipgloss.NewStyle().Foreground(lipgloss.Color(colorDim)).Render(noteStr)

	content := statusCol + " " + envCol + " " + serverCol + " " + principalCol + " " + submittedCol + " " + noteCol

	if selected {
		return renderSelectedRow(content, iw)
	}
	return renderNormalRow(content)
}

func statusLabel(s string) string {
	switch s {
	case "APPROVED":
		return "approved"
	case "PENDING":
		return "pending"
	case "DENIED":
		return "denied"
	case "EXPIRED":
		return "expired"
	case "REVOKED":
		return "revoked"
	default:
		return strings.ToLower(s)
	}
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
