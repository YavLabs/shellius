package tui

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/shellius/tui/internal/api"
)

// linuxUserRE matches valid Linux/POSIX usernames: lowercase letters, digits,
// underscore, or hyphen; must start with a letter or underscore; max 32 chars.
// Mirrors LINUX_USER_RE from the frontend.
var linuxUserRE = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)

// accessRequestState tracks the approval workflow step.
type accessRequestState int

const (
	arStateLoadingIntent accessRequestState = iota // fetching intent from API
	arStateForm                                     // user filling in the form
	arStateSubmitting                               // POST /api/access-requests in flight
	arStatePolling                                  // waiting for APPROVED/DENIED/…
	arStateApproved                                 // approved — fetching credentials
	arStateDenied                                   // denied / revoked / expired
	arStateWebTerminal                              // key download disabled; opened browser
	arStateError                                    // unrecoverable error
)

// arIntentLoadedMsg carries the access intent response.
type arIntentLoadedMsg struct{ intent api.AccessIntent }

// arIntentErrMsg carries an intent fetch error (non-fatal; we proceed with defaults).
type arIntentErrMsg struct{ err error }

// arSubmittedMsg carries the created access request.
type arSubmittedMsg struct{ req api.AccessRequest }

// arPollMsg carries a polled access request.
type arPollMsg struct{ req api.AccessRequest }

// arErrMsg carries an access request error.
type arErrMsg struct{ err error }

// arApprovedMsg signals the request was approved — carry the request ID so
// the parent can fetch credentials.
type arApprovedMsg struct{ requestID string }

// arWebTerminalMsg signals that the web terminal URL should be opened.
type arWebTerminalMsg struct{ url string }

// durationUnit represents a human-readable time unit for the duration field.
type durationUnit struct {
	label  string
	factor int // multiply amount by this to get seconds
}

var durationUnits = []durationUnit{
	{label: "minutes", factor: 60},
	{label: "hours", factor: 3600},
}

// arField indices for Tab navigation.
const (
	arFieldReason    = 0
	arFieldAmount    = 1
	arFieldPrincipal = 2
	arFieldCount     = 3
	// Protocol and unit selector are toggled inline, not textinput fields.
)

// AccessRequestModel handles the production access request form and polling.
type AccessRequestModel struct {
	client    *api.Client
	host      api.Host
	state     accessRequestState

	// intent data (populated after arStateLoadingIntent).
	intent api.AccessIntent

	// Form fields.
	inputs          [arFieldCount]textinput.Model
	focusIdx        int
	durationUnitIdx int    // index into durationUnits
	protocolSSH     bool   // true = SSH, false = RDP
	principals      []string // allowed principals (from intent); empty = free input
	principalIdx    int      // index into principals when len > 1

	spinner  spinner.Model
	request  api.AccessRequest
	errMsg   string
	formErr  string // inline validation error shown on the form
	webURL   string // populated when web terminal is opened
	width    int
	height   int
}

// NewAccessRequestModel creates the access request model for a given host.
// It begins by loading the access intent from the API.
func NewAccessRequestModel(client *api.Client, host api.Host) AccessRequestModel {
	reason := textinput.New()
	reason.Placeholder = "Describe why you need access (min 10 characters)..."
	reason.CharLimit = 512
	reason.Width = 60
	reason.Focus()

	amount := textinput.New()
	amount.Placeholder = "1"
	amount.CharLimit = 6
	amount.Width = 8
	amount.SetValue("1")

	principal := textinput.New()
	principal.Placeholder = "ubuntu"
	principal.CharLimit = 32
	principal.Width = 24

	s := spinner.New()
	s.Spinner = spinner.Dot
	s.Style = lipgloss.NewStyle().Foreground(lipgloss.Color(colorAccent))

	m := AccessRequestModel{
		client:          client,
		host:            host,
		state:           arStateLoadingIntent,
		durationUnitIdx: 1, // default: hours
		protocolSSH:     true,
		spinner:         s,
	}
	m.inputs[arFieldReason] = reason
	m.inputs[arFieldAmount] = amount
	m.inputs[arFieldPrincipal] = principal

	// Pre-fill principal from host if available.
	if host.Principal != "" {
		m.inputs[arFieldPrincipal].SetValue(host.Principal)
	}

	return m
}

func (m AccessRequestModel) Init() tea.Cmd {
	return tea.Batch(
		m.inputs[0].Focus(),
		m.spinner.Tick,
		m.fetchIntent(),
	)
}

// fetchIntent loads the access intent from the API.
func (m AccessRequestModel) fetchIntent() tea.Cmd {
	client := m.client
	hostID := m.host.ID
	return func() tea.Msg {
		intent, err := client.GetAccessIntent(hostID)
		if err != nil {
			return arIntentErrMsg{err: err}
		}
		return arIntentLoadedMsg{intent: intent}
	}
}

func (m AccessRequestModel) Update(msg tea.Msg) (AccessRequestModel, tea.Cmd) {
	switch msg := msg.(type) {

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height

	case arIntentLoadedMsg:
		m.intent = msg.intent

		// Pre-fill principal from intent if available.
		if msg.intent.PreferredPrincipal != "" {
			m.inputs[arFieldPrincipal].SetValue(msg.intent.PreferredPrincipal)
		}
		if len(msg.intent.AllowedPrincipals) > 0 {
			m.principals = msg.intent.AllowedPrincipals
			// Set the text field to the first allowed principal.
			m.inputs[arFieldPrincipal].SetValue(m.principals[0])
		}
		// Pre-select protocol from intent.
		if msg.intent.Protocol == "RDP" {
			m.protocolSSH = false
		}

		// If the user already has active access, skip the form and jump straight
		// to credentials fetch — arApprovedMsg handled in parent app.go.
		if msg.intent.HasActiveAccess && msg.intent.ActiveAccessRequest != nil {
			m.state = arStateApproved
			arID := msg.intent.ActiveAccessRequest.ID
			return m, func() tea.Msg { return arApprovedMsg{requestID: arID} }
		}

		// If there's already a pending request, show the polling state.
		if msg.intent.HasPendingRequest && msg.intent.ActiveAccessRequest != nil {
			m.request = *msg.intent.ActiveAccessRequest
			m.state = arStatePolling
			return m, m.pollRequest()
		}

		// Otherwise show the form.
		m.state = arStateForm
		return m, m.inputs[arFieldReason].Focus()

	case arIntentErrMsg:
		// Non-fatal — intent failed (maybe older server). Proceed with form defaults.
		m.state = arStateForm
		return m, m.inputs[arFieldReason].Focus()

	case tea.KeyMsg:
		switch m.state {
		case arStateLoadingIntent:
			// No key input while loading.
			return m, nil

		case arStatePolling, arStateApproved, arStateWebTerminal:
			// No key input in these states.
			return m, nil

		case arStateDenied, arStateError:
			if msg.String() == "esc" {
				return m, func() tea.Msg { return navBackMsg{} }
			}
			return m, nil

		case arStateForm:
			return m.handleFormKey(msg)
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
			// Still PENDING — keep polling every 3 seconds.
			return m, m.pollRequest()
		}

	case arErrMsg:
		// If in form state, show inline error and stay on form.
		if m.state == arStateForm || m.state == arStateSubmitting {
			m.state = arStateForm
			m.formErr = msg.err.Error()
			return m, m.syncFocus()
		}
		m.state = arStateError
		m.errMsg = msg.err.Error()
		return m, nil

	case arWebTerminalMsg:
		m.webURL = msg.url
		m.state = arStateWebTerminal
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

func (m AccessRequestModel) handleFormKey(msg tea.KeyMsg) (AccessRequestModel, tea.Cmd) {
	switch msg.String() {
	case "tab", "down":
		m.focusIdx = (m.focusIdx + 1) % arFieldCount
		return m, m.syncFocus()

	case "shift+tab", "up":
		m.focusIdx = (m.focusIdx - 1 + arFieldCount) % arFieldCount
		return m, m.syncFocus()

	case "left", "right":
		// On the principal field with multiple allowed principals, cycle through them.
		if m.focusIdx == arFieldPrincipal && len(m.principals) > 1 {
			if msg.String() == "left" {
				m.principalIdx = (m.principalIdx - 1 + len(m.principals)) % len(m.principals)
			} else {
				m.principalIdx = (m.principalIdx + 1) % len(m.principals)
			}
			m.inputs[arFieldPrincipal].SetValue(m.principals[m.principalIdx])
			return m, nil
		}
		// On the amount field, left/right changes duration unit.
		if m.focusIdx == arFieldAmount {
			if msg.String() == "left" {
				m.durationUnitIdx = (m.durationUnitIdx - 1 + len(durationUnits)) % len(durationUnits)
			} else {
				m.durationUnitIdx = (m.durationUnitIdx + 1) % len(durationUnits)
			}
			return m, nil
		}
		// On reason field, left/right toggles protocol.
		if m.focusIdx == arFieldReason {
			m.protocolSSH = !m.protocolSSH
			return m, nil
		}

	case "p":
		// 'p' anywhere on form toggles protocol (shortcut).
		if m.focusIdx != arFieldReason && m.focusIdx != arFieldPrincipal {
			m.protocolSSH = !m.protocolSSH
			return m, nil
		}

	case "enter":
		if m.focusIdx == arFieldCount-1 {
			// On last field: submit.
			return m, m.validateAndSubmit()
		}
		m.focusIdx = (m.focusIdx + 1) % arFieldCount
		return m, m.syncFocus()

	case "esc":
		return m, func() tea.Msg { return navBackMsg{} }
	}

	// Delegate to focused input.
	var cmd tea.Cmd
	m.inputs[m.focusIdx], cmd = m.inputs[m.focusIdx].Update(msg)
	// Clear inline form error on any input change.
	m.formErr = ""
	return m, cmd
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

func (m AccessRequestModel) validateAndSubmit() tea.Cmd {
	reason := strings.TrimSpace(m.inputs[arFieldReason].Value())
	if len(reason) < 10 {
		return func() tea.Msg {
			return arErrMsg{err: fmt.Errorf("reason must be at least 10 characters (currently %d)", len(reason))}
		}
	}

	amountStr := strings.TrimSpace(m.inputs[arFieldAmount].Value())
	amount, err := strconv.Atoi(amountStr)
	if err != nil || amount <= 0 {
		return func() tea.Msg {
			return arErrMsg{err: fmt.Errorf("duration must be a positive number")}
		}
	}
	unit := durationUnits[m.durationUnitIdx]
	durationSec := amount * unit.factor
	// Clamp to API bounds: 60s (1 min) to 604800s (7 days).
	if durationSec < 60 {
		durationSec = 60
	}
	if durationSec > 604800 {
		durationSec = 604800
	}

	principalVal := strings.TrimSpace(m.inputs[arFieldPrincipal].Value())
	if !linuxUserRE.MatchString(principalVal) {
		return func() tea.Msg {
			return arErrMsg{err: fmt.Errorf("principal must be a valid Linux username (lowercase, letters/digits/_/-, start with letter or _, max 32 chars)")}
		}
	}

	protocol := "SSH"
	if !m.protocolSSH {
		protocol = "RDP"
	}

	client := m.client
	host := m.host
	return func() tea.Msg {
		req, err := client.SubmitAccessRequest(host.ID, reason, durationSec, principalVal, protocol)
		if err != nil {
			return arErrMsg{err: err}
		}
		return arSubmittedMsg{req: req}
	}
}

func (m AccessRequestModel) pollRequest() tea.Cmd {
	reqID := m.request.ID
	client := m.client
	return tea.Tick(3*time.Second, func(_ time.Time) tea.Msg {
		req, err := client.GetAccessRequest(reqID)
		if err != nil {
			return arErrMsg{err: err}
		}
		return arPollMsg{req: req}
	})
}

func (m AccessRequestModel) View() string {
	var b strings.Builder

	b.WriteString(TitleStyle.Render("Request Access"))
	b.WriteString("\n")

	// Host summary line.
	serverName := m.host.Name
	if serverName == "" {
		serverName = m.host.Hostname
	}
	hostLine := fmt.Sprintf("%s  %s  %s",
		EnvBadge(m.host.Environment),
		lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colorText)).Render(serverName),
		MutedStyle.Render(m.host.CustomerName),
	)
	b.WriteString(hostLine)
	b.WriteString("\n")
	// Thin separator.
	b.WriteString(SeparatorStyle.Render(strings.Repeat("─", 48)))
	b.WriteString("\n\n")

	switch m.state {
	case arStateLoadingIntent:
		b.WriteString("  ")
		b.WriteString(m.spinner.View())
		b.WriteString("  ")
		b.WriteString(MutedStyle.Render("Loading access context..."))

	case arStateForm:
		b.WriteString(m.renderForm())

	case arStateSubmitting:
		b.WriteString("  ")
		b.WriteString(m.spinner.View())
		b.WriteString(MutedStyle.Render("  Submitting access request..."))

	case arStatePolling:
		b.WriteString("  ")
		b.WriteString(m.spinner.View())
		b.WriteString(MutedStyle.Render("  Waiting for approval..."))
		b.WriteString("\n\n")
		b.WriteString(MutedStyle.Render("  Request: "))
		b.WriteString(CodeStyle.Render(m.request.ID))
		b.WriteString("\n")
		b.WriteString(MutedStyle.Render("  Status:  "))
		b.WriteString(StatusBadge(m.request.Status))
		b.WriteString("\n\n")
		b.WriteString(DimStyle.Render("  › Your manager will receive an approval notification. Polling every 3s..."))

	case arStateApproved:
		b.WriteString(SuccessStyle.Render("  Access approved!"))
		b.WriteString("\n")
		b.WriteString(MutedStyle.Render("  Fetching credentials and connecting..."))

	case arStateDenied:
		b.WriteString(ErrorStyle.Render("  Access denied"))
		b.WriteString("\n")
		reason := m.request.DeniedReason
		if reason == "" {
			reason = m.request.Status
		}
		b.WriteString(MutedStyle.Render("  Reason: " + reason))
		b.WriteString("\n\n")
		b.WriteString(HelpBarStyle.Render("  press esc to go back"))

	case arStateWebTerminal:
		b.WriteString(SuccessStyle.Render("  Web terminal opened in your browser."))
		b.WriteString("\n\n")
		b.WriteString(MutedStyle.Render("  URL: "))
		b.WriteString(CodeStyle.Render(m.webURL))
		b.WriteString("\n\n")
		b.WriteString(DimStyle.Render("  › Key download is disabled by policy. Use the web terminal to connect."))
		b.WriteString("\n\n")
		b.WriteString(HelpBarStyle.Render("  press esc to go back"))

	case arStateError:
		b.WriteString(ErrorStyle.Render("  Error"))
		b.WriteString("\n")
		b.WriteString(MutedStyle.Render("  " + m.errMsg))
		b.WriteString("\n\n")
		b.WriteString(HelpBarStyle.Render("  press esc to go back"))
	}

	return b.String()
}

func (m AccessRequestModel) renderForm() string {
	var b strings.Builder

	// Protocol radio (SSH / RDP) — shown at the top.
	b.WriteString(InputLabelStyle.Render("Protocol"))
	b.WriteString("\n")
	sshLabel := "  SSH"
	rdpLabel := "  RDP"
	if m.protocolSSH {
		b.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color(colorAccent)).Bold(true).Render("  ● SSH"))
		b.WriteString(MutedStyle.Render("  ○ RDP"))
	} else {
		b.WriteString(MutedStyle.Render("  ○ SSH"))
		b.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color(colorAccent)).Bold(true).Render("  ● RDP"))
	}
	_ = sshLabel
	_ = rdpLabel
	b.WriteString(DimStyle.Render("  (p to toggle)"))
	b.WriteString("\n\n")

	// Reason field.
	reasonLabel := InputLabelStyle.Render("Reason")
	if m.focusIdx == arFieldReason {
		reasonLabel = FocusedInputStyle.Render("Reason")
	}
	b.WriteString(reasonLabel)
	b.WriteString("\n")
	b.WriteString(m.inputs[arFieldReason].View())
	b.WriteString("\n\n")

	// Duration: amount + unit selector on one line.
	amountLabel := InputLabelStyle.Render("Duration")
	if m.focusIdx == arFieldAmount {
		amountLabel = FocusedInputStyle.Render("Duration")
	}
	b.WriteString(amountLabel)
	b.WriteString("\n")
	b.WriteString(m.inputs[arFieldAmount].View())
	b.WriteString("  ")
	unit := durationUnits[m.durationUnitIdx]
	b.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color(colorAccent)).Render(unit.label))
	b.WriteString(DimStyle.Render("  (←/→ to change unit)"))
	b.WriteString("\n\n")

	// Principal field.
	principalLabel := InputLabelStyle.Render("Principal (SSH username)")
	if m.focusIdx == arFieldPrincipal {
		principalLabel = FocusedInputStyle.Render("Principal (SSH username)")
	}
	b.WriteString(principalLabel)
	b.WriteString("\n")

	if len(m.principals) > 1 {
		// Cycle selector for multiple allowed principals.
		prev := (m.principalIdx - 1 + len(m.principals)) % len(m.principals)
		next := (m.principalIdx + 1) % len(m.principals)
		b.WriteString(MutedStyle.Render("  ← "))
		b.WriteString(MutedStyle.Render(m.principals[prev]))
		b.WriteString("  ")
		b.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color(colorAccent)).Bold(true).Render(m.principals[m.principalIdx]))
		b.WriteString("  ")
		b.WriteString(MutedStyle.Render(m.principals[next]))
		b.WriteString(MutedStyle.Render(" →"))
		b.WriteString(DimStyle.Render("  (←/→ to cycle)"))
		b.WriteString("\n")
	} else {
		b.WriteString(m.inputs[arFieldPrincipal].View())
		b.WriteString("\n")
	}

	// Inline form validation error.
	if m.formErr != "" {
		b.WriteString("\n")
		b.WriteString(ErrorStyle.Render("  ! " + m.formErr))
		b.WriteString("\n")
	}

	b.WriteString("\n")
	b.WriteString(HelpBarStyle.Render("tab/shift+tab navigate · enter submit · esc cancel · ←/→ cycle options"))
	return b.String()
}

// formatDuration returns a human-readable duration string.
func formatDuration(d time.Duration) string {
	d = d.Round(time.Second)
	h := int(d.Hours())
	mn := int(d.Minutes()) % 60
	s := int(d.Seconds()) % 60
	if h > 0 {
		return fmt.Sprintf("%dh%dm", h, mn)
	}
	if mn > 0 {
		return fmt.Sprintf("%dm%ds", mn, s)
	}
	return fmt.Sprintf("%ds", s)
}

// nowFunc is a variable so tests can override it.
var nowFunc = time.Now

// isKeyDownloadDisabled returns true when the error from GetSshCredentials
// indicates that key download is disabled by policy (HTTP 403).
func isKeyDownloadDisabled(err error) bool {
	if err == nil {
		return false
	}
	var httpErr *api.HTTPError
	if errors.As(err, &httpErr) && httpErr.Status == 403 {
		return true
	}
	// Fallback: check message substring for older server responses.
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "key download is disabled") || strings.Contains(msg, "web terminal")
}
