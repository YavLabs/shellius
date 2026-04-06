package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/shellius/tui/internal/auth"
	"github.com/shellius/tui/internal/config"
)

// Login view states.
type loginState int

const (
	loginStateIdle loginState = iota
	loginStateEnterOrg
	loginStateFetchingCode
	loginStateDisplayingCode
	loginStatePolling
	loginStateSuccess
	loginStateError
)

// LoginModel is the Bubble Tea model for the device auth login screen.
type LoginModel struct {
	cfg       *config.Config
	state     loginState
	orgInput  textinput.Model
	spinner   spinner.Model
	deviceResp auth.DeviceAuthResponse
	errMsg    string
	width     int
	height    int
}

// Msgs sent within the login model.
type deviceAuthStartedMsg struct {
	resp auth.DeviceAuthResponse
}

type deviceAuthTokenMsg struct {
	token auth.TokenResponse
}

type deviceAuthErrMsg struct {
	err error
}

// NewLoginModel creates the initial login model.
func NewLoginModel(cfg *config.Config) LoginModel {
	ti := textinput.New()
	ti.Placeholder = "your-org-slug"
	ti.Focus()
	ti.CharLimit = 64
	ti.Width = 32

	s := spinner.New()
	s.Spinner = spinner.Dot
	s.Style = lipgloss.NewStyle().Foreground(lipgloss.Color(colorAccent))

	return LoginModel{
		cfg:      cfg,
		state:    loginStateEnterOrg,
		orgInput: ti,
		spinner:  s,
	}
}

func (m LoginModel) Init() tea.Cmd {
	return tea.Batch(m.orgInput.Focus(), m.spinner.Tick)
}

func (m LoginModel) Update(msg tea.Msg) (LoginModel, tea.Cmd) {
	switch msg := msg.(type) {

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height

	case tea.KeyMsg:
		switch msg.String() {
		case "enter":
			if m.state == loginStateEnterOrg {
				orgSlug := strings.TrimSpace(m.orgInput.Value())
				if orgSlug == "" {
					return m, nil
				}
				m.state = loginStateFetchingCode
				return m, m.startDeviceFlow(orgSlug)
			}
		}

	case deviceAuthStartedMsg:
		m.deviceResp = msg.resp
		m.state = loginStateDisplayingCode
		auth.OpenBrowser(m.deviceResp.VerificationUriComplete)
		return m, m.pollForToken()

	case deviceAuthTokenMsg:
		if err := auth.SaveTokens(m.cfg, msg.token); err != nil {
			m.state = loginStateError
			m.errMsg = "Failed to save tokens: " + err.Error()
			return m, nil
		}
		m.state = loginStateSuccess
		return m, sendLoginSuccessMsg()

	case deviceAuthErrMsg:
		if auth.IsAuthorizationPending(msg.err) || auth.IsSlowDown(msg.err) {
			// Still polling — keep going.
			return m, m.pollForToken()
		}
		m.state = loginStateError
		m.errMsg = msg.err.Error()
		return m, nil

	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd
	}

	if m.state == loginStateEnterOrg {
		var cmd tea.Cmd
		m.orgInput, cmd = m.orgInput.Update(msg)
		return m, cmd
	}

	return m, nil
}

func (m LoginModel) View() string {
	var b strings.Builder

	b.WriteString("\n")
	b.WriteString(TitleStyle.Render("Shellius"))
	b.WriteString("\n")
	b.WriteString(SubtitleStyle.Render("Centralized SSH/RDP Access Management"))
	b.WriteString("\n\n")

	switch m.state {
	case loginStateEnterOrg:
		b.WriteString(InputLabelStyle.Render("Enter your organization slug:"))
		b.WriteString("\n")
		b.WriteString(m.orgInput.View())
		b.WriteString("\n\n")
		b.WriteString(HelpBarStyle.Render("press enter to continue  •  ctrl+c to quit"))

	case loginStateFetchingCode:
		b.WriteString(m.spinner.View())
		b.WriteString(MutedStyle.Render("  Connecting to " + m.cfg.ServerURL + "..."))

	case loginStateDisplayingCode, loginStatePolling:
		b.WriteString(MutedStyle.Render("Open this URL in your browser and enter the code:"))
		b.WriteString("\n\n")
		b.WriteString("  ")
		b.WriteString(CodeStyle.Render(m.deviceResp.VerificationUri))
		b.WriteString("\n\n")
		b.WriteString(MutedStyle.Render("  Your code:  "))
		b.WriteString(
			lipgloss.NewStyle().
				Bold(true).
				Foreground(lipgloss.Color(colorText)).
				Background(lipgloss.Color(colorHighlight)).
				Padding(0, 2).
				Render(m.deviceResp.UserCode),
		)
		b.WriteString("\n\n")
		b.WriteString("  ")
		b.WriteString(m.spinner.View())
		b.WriteString(MutedStyle.Render("  Waiting for browser approval..."))
		b.WriteString("\n\n")
		b.WriteString(HelpBarStyle.Render("browser opened automatically  •  ctrl+c to cancel"))

	case loginStateSuccess:
		b.WriteString(SuccessStyle.Render("Login successful!"))
		b.WriteString("\n")
		if m.cfg.Username != "" {
			b.WriteString(MutedStyle.Render("Welcome, " + m.cfg.Username))
		}

	case loginStateError:
		b.WriteString(ErrorStyle.Render("Login failed"))
		b.WriteString("\n")
		b.WriteString(MutedStyle.Render(m.errMsg))
		b.WriteString("\n\n")
		b.WriteString(HelpBarStyle.Render("press ctrl+c to quit"))
	}

	return b.String()
}

// startDeviceFlow sends a command to kick off the device auth flow.
func (m LoginModel) startDeviceFlow(orgSlug string) tea.Cmd {
	return func() tea.Msg {
		resp, err := auth.StartDeviceFlow(m.cfg.ServerURL, orgSlug)
		if err != nil {
			return deviceAuthErrMsg{err: err}
		}
		return deviceAuthStartedMsg{resp: resp}
	}
}

// pollForToken sends a command to poll for a token.
func (m LoginModel) pollForToken() tea.Cmd {
	deviceCode := m.deviceResp.DeviceCode
	interval := m.deviceResp.Interval
	serverURL := m.cfg.ServerURL
	return func() tea.Msg {
		token, err := auth.PollForToken(serverURL, deviceCode, interval)
		if err != nil {
			return deviceAuthErrMsg{err: err}
		}
		return deviceAuthTokenMsg{token: token}
	}
}

// loginSuccessMsg signals that login completed successfully.
type loginSuccessMsg struct{}

func sendLoginSuccessMsg() tea.Cmd {
	return func() tea.Msg { return loginSuccessMsg{} }
}

// OrgSlug returns the entered org slug (used when building the device auth request).
func (m LoginModel) OrgSlug() string {
	return strings.TrimSpace(m.orgInput.Value())
}

// ServerURLPromptModel is a minimal model used before the org slug is known,
// allowing the user to type the server URL on first run.
type ServerURLPromptModel struct {
	input  textinput.Model
	cfg    *config.Config
	done   bool
}

// NewServerURLPrompt creates a prompt to capture the server URL.
func NewServerURLPrompt(cfg *config.Config) ServerURLPromptModel {
	ti := textinput.New()
	ti.Placeholder = "http://localhost:3000"
	ti.Focus()
	ti.CharLimit = 256
	ti.Width = 48
	if cfg.ServerURL != "" {
		ti.SetValue(cfg.ServerURL)
	}
	return ServerURLPromptModel{input: ti, cfg: cfg}
}

func (m ServerURLPromptModel) Init() tea.Cmd { return m.input.Focus() }

func (m ServerURLPromptModel) Update(msg tea.Msg) (ServerURLPromptModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		if msg.String() == "enter" {
			val := strings.TrimSpace(m.input.Value())
			if val != "" {
				m.cfg.ServerURL = val
				m.done = true
				return m, nil
			}
		}
	}
	var cmd tea.Cmd
	m.input, cmd = m.input.Update(msg)
	return m, cmd
}

func (m ServerURLPromptModel) View() string {
	return fmt.Sprintf(
		"\n%s\n\n%s\n%s\n\n%s",
		TitleStyle.Render("Shellius Setup"),
		InputLabelStyle.Render("Enter your Shellius server URL:"),
		m.input.View(),
		HelpBarStyle.Render("press enter to continue  •  ctrl+c to quit"),
	)
}

// Done returns true once the user has submitted the server URL.
func (m ServerURLPromptModel) Done() bool { return m.done }
