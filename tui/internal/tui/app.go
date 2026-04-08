package tui

import (
	"errors"
	"fmt"
	"os"
	"os/exec"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/shellius/tui/internal/api"
	"github.com/shellius/tui/internal/config"
	"github.com/shellius/tui/internal/logx"
	sshpkg "github.com/shellius/tui/internal/ssh"
)

// view identifies which screen is currently active.
type view int

const (
	viewServerURL view = iota
	viewLogin
	viewHostList
	viewAccessRequest
	viewConnecting
	viewError
)

// navBackMsg signals that the current sub-view wants to return to the previous screen.
type navBackMsg struct{}

// AppModel is the root Bubble Tea model. It owns all sub-models and routes
// messages / views between them.
type AppModel struct {
	cfg           *config.Config
	client        *api.Client
	currentView   view
	urlPrompt     ServerURLPromptModel
	loginModel    LoginModel
	hostList      HostListModel
	accessRequest AccessRequestModel
	statusBar     *StatusBar
	selectedHost  api.Host
	errMsg        string
	// toastMsg is a non-destructive warning shown above the current view.
	// It does NOT change the active view.
	toastMsg string
	width     int
	height    int
}

// NewApp creates the root application model.
func NewApp(cfg *config.Config) AppModel {
	sb := NewStatusBar(cfg)

	m := AppModel{
		cfg:       cfg,
		statusBar: sb,
	}

	// Decide the initial view.
	// We treat the user as logged in whenever a refresh token is present —
	// the API client will transparently refresh the access token on first use.
	if cfg.ServerURL == "" {
		m.currentView = viewServerURL
		m.urlPrompt = NewServerURLPrompt(cfg)
	} else if cfg.RefreshToken == "" {
		m.currentView = viewLogin
		m.loginModel = NewLoginModel(cfg)
	} else {
		m.currentView = viewHostList
		m.client = api.New(cfg)
		m.hostList = NewHostListModel(m.client)
	}

	return m
}

// Init runs the initial command for whichever view is active.
func (m AppModel) Init() tea.Cmd {
	switch m.currentView {
	case viewServerURL:
		return m.urlPrompt.Init()
	case viewLogin:
		return m.loginModel.Init()
	case viewHostList:
		return m.hostList.Init()
	}
	return nil
}

// Update is the central message dispatcher.
func (m AppModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.statusBar.SetWidth(msg.Width)
		// Forward to active sub-models.
		m.urlPrompt, _ = m.urlPrompt.Update(msg)
		m.loginModel, _ = m.loginModel.Update(msg)
		m.hostList, _ = m.hostList.Update(msg)
		if m.currentView == viewAccessRequest {
			m.accessRequest, _ = m.accessRequest.Update(msg)
		}
		return m, nil

	case tea.KeyMsg:
		// Global quit — ctrl+c always exits. We do NOT bind plain 'q'
		// because it conflicts with typing into the host filter.
		if msg.String() == "ctrl+c" {
			return m, tea.Quit
		}
	}

	// Handle non-destructive toast messages that can arrive from any view.
	switch msg := msg.(type) {
	case urlSaveErrMsg:
		logx.Warnf("app: failed to save config after URL entry: %v", msg.err)
		m.toastMsg = fmt.Sprintf("Warning: could not save config: %v", msg.err)
	case hostsErrMsg:
		// If the host-fetch failed only because of a refresh failure, show a
		// toast instead of sending the user to the error screen.
		if errors.Is(msg.err, api.ErrTokenRefreshFailed) {
			logx.Warnf("app: token refresh failed, showing toast: %v", msg.err)
			m.toastMsg = "Warning: token refresh failed — showing cached data. Check your network."
			// Let the hostlist model also handle it so it transitions out of
			// the loading state.
		}
	}

	// Route to active view.
	switch m.currentView {
	case viewServerURL:
		return m.updateServerURL(msg)
	case viewLogin:
		return m.updateLogin(msg)
	case viewHostList:
		return m.updateHostList(msg)
	case viewAccessRequest:
		return m.updateAccessRequest(msg)
	case viewError:
		return m.updateError(msg)
	}

	return m, nil
}

func (m AppModel) updateServerURL(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd
	m.urlPrompt, cmd = m.urlPrompt.Update(msg)
	if m.urlPrompt.Done() {
		// Save and move to login.
		_ = m.cfg.Save()
		m.currentView = viewLogin
		m.loginModel = NewLoginModel(m.cfg)
		return m, m.loginModel.Init()
	}
	return m, cmd
}

func (m AppModel) updateLogin(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg.(type) {
	case loginSuccessMsg:
		// Transition to host list.
		m.client = api.New(m.cfg)
		m.hostList = NewHostListModel(m.client)
		m.currentView = viewHostList
		return m, m.hostList.Init()
	}

	var cmd tea.Cmd
	m.loginModel, cmd = m.loginModel.Update(msg)
	return m, cmd
}

func (m AppModel) updateHostList(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case hostSelectedMsg:
		m.selectedHost = msg.host
		if msg.host.AccessStatus == "requires_approval" || msg.host.Environment == "prod" {
			m.currentView = viewAccessRequest
			m.accessRequest = NewAccessRequestModel(m.client, msg.host)
			return m, m.accessRequest.Init()
		}
		// Direct access — fetch credentials and connect.
		return m, m.connectDirect(msg.host)
	}

	var cmd tea.Cmd
	m.hostList, cmd = m.hostList.Update(msg)
	return m, cmd
}

func (m AppModel) updateAccessRequest(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case navBackMsg:
		m.currentView = viewHostList
		return m, nil

	case arApprovedMsg:
		// Fetch SSH credentials for the approved request and connect.
		reqID := msg.requestID
		client := m.client
		host := m.selectedHost
		return m, func() tea.Msg {
			creds, err := client.GetSshCredentials(reqID)
			if err != nil {
				return appErrMsg{err: fmt.Errorf("get SSH credentials: %w", err)}
			}
			return sshConnectMsg{creds: creds, host: host}
		}

	case sshConnectMsg:
		return m, m.execSSH(msg.creds, msg.host)

	case appErrMsg:
		m.currentView = viewError
		m.errMsg = msg.err.Error()
		return m, nil
	}

	var cmd tea.Cmd
	m.accessRequest, cmd = m.accessRequest.Update(msg)
	return m, cmd
}

func (m AppModel) updateError(msg tea.Msg) (tea.Model, tea.Cmd) {
	if kMsg, ok := msg.(tea.KeyMsg); ok {
		switch kMsg.String() {
		case "esc", "q", "enter":
			m.currentView = viewHostList
			return m, nil
		}
	}
	return m, nil
}

// connectDirect fetches credentials for a non-prod host and connects.
func (m AppModel) connectDirect(host api.Host) tea.Cmd {
	client := m.client
	return func() tea.Msg {
		// For non-prod we need to get credentials too — use a minimal access request.
		// If the server returns direct credentials via a different endpoint this
		// can be updated. For now, create a short-lived access request and poll
		// until approved (auto-approval for non-prod).
		req, err := client.SubmitAccessRequest(host.ID, "Direct access via Shellius TUI", 3600, host.Principal)
		if err != nil {
			return appErrMsg{err: fmt.Errorf("request credentials: %w", err)}
		}
		// Poll until approved (non-prod should auto-approve quickly).
		for i := 0; i < 10; i++ {
			updated, pollErr := client.GetAccessRequest(req.ID)
			if pollErr != nil {
				return appErrMsg{err: fmt.Errorf("poll access request: %w", pollErr)}
			}
			switch updated.Status {
			case "APPROVED":
				creds, credErr := client.GetSshCredentials(updated.ID)
				if credErr != nil {
					return appErrMsg{err: fmt.Errorf("get SSH credentials: %w", credErr)}
				}
				return sshConnectMsg{creds: creds, host: host}
			case "DENIED", "REVOKED", "EXPIRED":
				return appErrMsg{err: fmt.Errorf("access request %s", updated.Status)}
			}
		}
		return appErrMsg{err: fmt.Errorf("access request timed out waiting for approval")}
	}
}

// sshConnectMsg carries credentials and the target host for the SSH connection.
type sshConnectMsg struct {
	creds api.SshCreds
	host  api.Host
}

// appErrMsg carries a top-level application error.
type appErrMsg struct{ err error }

// execSSH writes temp credentials and uses tea.ExecProcess to hand off the
// terminal to an SSH subprocess.
func (m AppModel) execSSH(creds api.SshCreds, host api.Host) tea.Cmd {
	keyPath, certPath, cleanup, err := sshpkg.WriteTempCreds(creds)
	if err != nil {
		return func() tea.Msg {
			return appErrMsg{err: fmt.Errorf("write SSH credentials: %w", err)}
		}
	}

	user := creds.Username
	if user == "" {
		user = host.Principal
	}
	if user == "" {
		user = "root"
	}
	hostname := creds.Hostname
	if hostname == "" {
		hostname = host.Hostname
	}
	port := creds.Port
	if port == 0 {
		port = host.Port
	}
	if port == 0 {
		port = 22
	}

	sshCmd := sshpkg.BuildCommand(hostname, port, user, keyPath, certPath)

	return tea.ExecProcess(sshCmd, func(err error) tea.Msg {
		cleanup()
		if err != nil {
			// Exit code 1 from ssh is normal (remote closed connection).
			if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
				return nil
			}
			return appErrMsg{err: fmt.Errorf("SSH session: %w", err)}
		}
		return nil
	})
}

// View renders the currently active screen.
func (m AppModel) View() string {
	var content string

	switch m.currentView {
	case viewServerURL:
		content = m.urlPrompt.View()
	case viewLogin:
		content = m.loginModel.View()
	case viewHostList:
		content = m.hostList.View()
	case viewAccessRequest:
		content = m.accessRequest.View()
	case viewConnecting:
		content = MutedStyle.Render("Connecting...")
	case viewError:
		content = fmt.Sprintf("%s\n\n%s\n\n%s",
			ErrorStyle.Render("Error"),
			MutedStyle.Render(m.errMsg),
			HelpBarStyle.Render("press esc or enter to go back  •  ctrl+c to quit"),
		)
	}

	// Prepend any non-destructive toast warning.
	if m.toastMsg != "" {
		content = ToastStyle.Render(m.toastMsg) + "\n" + content
	}

	// Only show status bar after login.
	if m.currentView != viewServerURL && m.currentView != viewLogin {
		return AppStyle.Render(content) + "\n" + m.statusBar.View()
	}
	return AppStyle.Render(content)
}

// Run starts the Bubble Tea program.
func Run(cfg *config.Config) error {
	if err := sshpkg.ValidateSSHAvailable(); err != nil {
		fmt.Fprintf(os.Stderr, "warning: %v\n", err)
	}

	model := NewApp(cfg)
	p := tea.NewProgram(model, tea.WithAltScreen())
	_, err := p.Run()
	return err
}
