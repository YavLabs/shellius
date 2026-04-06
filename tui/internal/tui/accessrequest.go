package tui

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/shellius/tui/internal/api"
)

// accessRequestState tracks the approval workflow step.
type accessRequestState int

const (
	arStateForm accessRequestState = iota
	arStateSubmitting
	arStatePolling
	arStateApproved
	arStateDenied
	arStateError
)

// arSubmittedMsg carries the created access request.
type arSubmittedMsg struct{ req api.AccessRequest }

// arPollMsg carries a polled access request.
type arPollMsg struct{ req api.AccessRequest }

// arErrMsg carries an access request error.
type arErrMsg struct{ err error }

// arApprovedMsg signals the request was approved — carry the request ID so
// the parent can fetch credentials.
type arApprovedMsg struct{ requestID string }

// arConnectMsg signals that we have credentials and should connect.
type arConnectMsg struct {
	host api.Host
	req  api.AccessRequest
}

const (
	arFieldReason   = 0
	arFieldDuration = 1
	arFieldCount    = 2
)

// AccessRequestModel handles the production access request form and polling.
type AccessRequestModel struct {
	client    *api.Client
	host      api.Host
	state     accessRequestState
	inputs    [arFieldCount]textinput.Model
	focusIdx  int
	spinner   spinner.Model
	request   api.AccessRequest
	errMsg    string
	width     int
	height    int
}

// NewAccessRequestModel creates the access request model for a given host.
func NewAccessRequestModel(client *api.Client, host api.Host) AccessRequestModel {
	reason := textinput.New()
	reason.Placeholder = "Reason for access..."
	reason.CharLimit = 512
	reason.Width = 60
	reason.Focus()

	duration := textinput.New()
	duration.Placeholder = "3600"
	duration.CharLimit = 10
	duration.Width = 20
	duration.SetValue("3600")

	s := spinner.New()
	s.Spinner = spinner.Dot
	s.Style = lipgloss.NewStyle().Foreground(lipgloss.Color(colorAccent))

	return AccessRequestModel{
		client:  client,
		host:    host,
		state:   arStateForm,
		inputs:  [arFieldCount]textinput.Model{reason, duration},
		spinner: s,
	}
}

func (m AccessRequestModel) Init() tea.Cmd {
	return tea.Batch(m.inputs[0].Focus(), m.spinner.Tick)
}

func (m AccessRequestModel) Update(msg tea.Msg) (AccessRequestModel, tea.Cmd) {
	switch msg := msg.(type) {

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height

	case tea.KeyMsg:
		if m.state != arStateForm {
			if m.state == arStateError && msg.String() == "esc" {
				return m, func() tea.Msg { return navBackMsg{} }
			}
			return m, nil
		}

		switch msg.String() {
		case "tab", "down":
			m.focusIdx = (m.focusIdx + 1) % arFieldCount
			return m, m.syncFocus()

		case "shift+tab", "up":
			m.focusIdx = (m.focusIdx - 1 + arFieldCount) % arFieldCount
			return m, m.syncFocus()

		case "enter":
			if m.focusIdx == arFieldCount-1 {
				return m, m.submitRequest()
			}
			m.focusIdx = (m.focusIdx + 1) % arFieldCount
			return m, m.syncFocus()

		case "esc":
			return m, func() tea.Msg { return navBackMsg{} }
		}

	case arSubmittedMsg:
		m.request = msg.req
		m.state = arStatePolling
		return m, m.pollRequest()

	case arPollMsg:
		m.request = msg.req
		switch msg.req.Status {
		case "APPROVED":
			m.state = arStateApproved
			return m, func() tea.Msg { return arApprovedMsg{requestID: msg.req.ID} }
		case "DENIED", "REVOKED", "EXPIRED":
			m.state = arStateDenied
			return m, nil
		default:
			// Still PENDING — keep polling.
			return m, m.pollRequest()
		}

	case arErrMsg:
		m.state = arStateError
		m.errMsg = msg.err.Error()
		return m, nil

	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd
	}

	// Delegate key presses to focused input in form state.
	if m.state == arStateForm {
		var cmd tea.Cmd
		m.inputs[m.focusIdx], cmd = m.inputs[m.focusIdx].Update(msg)
		return m, cmd
	}

	return m, nil
}

func (m AccessRequestModel) syncFocus() tea.Cmd {
	cmds := make([]tea.Cmd, arFieldCount)
	for i := range m.inputs {
		if i == m.focusIdx {
			cmds[i] = m.inputs[i].Focus()
		} else {
			m.inputs[i].Blur()
		}
	}
	return tea.Batch(cmds...)
}

func (m AccessRequestModel) submitRequest() tea.Cmd {
	reason := strings.TrimSpace(m.inputs[arFieldReason].Value())
	durationStr := strings.TrimSpace(m.inputs[arFieldDuration].Value())
	if reason == "" {
		reason = "Access requested via Shellius TUI"
	}
	duration := 3600
	if d, err := fmt.Sscanf(durationStr, "%d", &duration); d == 0 || err != nil {
		duration = 3600
	}

	client := m.client
	host := m.host
	return func() tea.Msg {
		req, err := client.SubmitAccessRequest(host.ID, reason, duration, host.Principal)
		if err != nil {
			return arErrMsg{err: err}
		}
		return arSubmittedMsg{req: req}
	}
}

func (m AccessRequestModel) pollRequest() tea.Cmd {
	reqID := m.request.ID
	client := m.client
	return tea.Tick(5*time.Second, func(_ time.Time) tea.Msg {
		req, err := client.GetAccessRequest(reqID)
		if err != nil {
			return arErrMsg{err: err}
		}
		return arPollMsg{req: req}
	})
}

func (m AccessRequestModel) View() string {
	var b strings.Builder

	b.WriteString(TitleStyle.Render("Request Production Access"))
	b.WriteString("\n")

	hostLine := fmt.Sprintf("%s  %s  %s",
		EnvBadge(m.host.Environment),
		lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colorText)).Render(m.host.Name),
		MutedStyle.Render(m.host.CustomerName),
	)
	b.WriteString(hostLine)
	b.WriteString("\n\n")

	switch m.state {
	case arStateForm:
		b.WriteString(m.renderForm())

	case arStateSubmitting:
		b.WriteString(m.spinner.View())
		b.WriteString(MutedStyle.Render("  Submitting access request..."))

	case arStatePolling:
		b.WriteString(m.spinner.View())
		b.WriteString(MutedStyle.Render("  Waiting for approval..."))
		b.WriteString("\n\n")
		b.WriteString(MutedStyle.Render("Request ID: "))
		b.WriteString(CodeStyle.Render(m.request.ID))
		b.WriteString("\n")
		b.WriteString(MutedStyle.Render("Status: "))
		b.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color(colorStaging)).Render(m.request.Status))
		b.WriteString("\n\n")
		b.WriteString(HelpBarStyle.Render("Your manager will receive an approval notification. Polling every 5s..."))

	case arStateApproved:
		b.WriteString(SuccessStyle.Render("Access approved!"))
		b.WriteString("\n")
		b.WriteString(MutedStyle.Render("Fetching credentials and connecting..."))

	case arStateDenied:
		b.WriteString(ErrorStyle.Render("Access denied"))
		b.WriteString("\n")
		b.WriteString(MutedStyle.Render(fmt.Sprintf("Request status: %s", m.request.Status)))
		b.WriteString("\n\n")
		b.WriteString(HelpBarStyle.Render("press esc to go back"))

	case arStateError:
		b.WriteString(ErrorStyle.Render("Error"))
		b.WriteString("\n")
		b.WriteString(MutedStyle.Render(m.errMsg))
		b.WriteString("\n\n")
		b.WriteString(HelpBarStyle.Render("press esc to go back"))
	}

	return b.String()
}

func (m AccessRequestModel) renderForm() string {
	var b strings.Builder

	labels := []string{"Reason for access:", "Duration (seconds):"}
	for i, label := range labels {
		var labelStyle lipgloss.Style
		if i == m.focusIdx {
			labelStyle = FocusedInputStyle
		} else {
			labelStyle = InputLabelStyle
		}
		b.WriteString(labelStyle.Render(label))
		b.WriteString("\n")
		b.WriteString(m.inputs[i].View())
		b.WriteString("\n\n")
	}

	b.WriteString(HelpBarStyle.Render("tab/shift+tab navigate  •  enter submit  •  esc cancel"))
	return b.String()
}

// formatDuration returns a human-readable duration string.
func formatDuration(d time.Duration) string {
	d = d.Round(time.Second)
	h := int(d.Hours())
	m := int(d.Minutes()) % 60
	s := int(d.Seconds()) % 60
	if h > 0 {
		return fmt.Sprintf("%dh%dm", h, m)
	}
	if m > 0 {
		return fmt.Sprintf("%dm%ds", m, s)
	}
	return fmt.Sprintf("%ds", s)
}

// nowFunc is a variable so tests can override it.
var nowFunc = time.Now
