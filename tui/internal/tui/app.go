package tui

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/shellius/tui/internal/api"
	"github.com/shellius/tui/internal/config"
	"github.com/shellius/tui/internal/logx"
	"github.com/shellius/tui/internal/sessions"
	sshpkg "github.com/shellius/tui/internal/ssh"
)

// view identifies which screen is currently active.
type view int

const (
	viewServerURL    view = iota
	viewLogin        // device-auth login
	viewActiveAccess // default: my approved access requests
	viewHostList     // /servers: full server browser
	viewAccessRequest
	viewHelp
	viewProfile
	viewSessions
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
	prevView      view // for Esc-back from overlays
	urlPrompt     ServerURLPromptModel
	loginModel    LoginModel
	activeAccess  activeAccessModel
	hostList      HostListModel
	accessRequest AccessRequestModel
	palette       paletteModel
	selectedHost  api.Host
	errMsg        string
	toastMsg      string
	width         int
	height        int
}

// NewApp creates the root application model.
func NewApp(cfg *config.Config) AppModel {
	m := AppModel{
		cfg:     cfg,
		palette: newPaletteModel(),
	}

	// Decide the initial view.
	if cfg.ServerURL == "" {
		m.currentView = viewServerURL
		m.urlPrompt = NewServerURLPrompt(cfg)
	} else if cfg.RefreshToken == "" {
		m.currentView = viewLogin
		m.loginModel = NewLoginModel(cfg)
	} else {
		// Logged in — show active-access picker as the default view.
		m.client = api.New(cfg)
		m.currentView = viewActiveAccess
		m.activeAccess = NewActiveAccessModel(m.client)
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
	case viewActiveAccess:
		return m.activeAccess.Init()
	}
	return nil
}

// Update is the central message dispatcher.
func (m AppModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.palette.width = msg.Width - 6 // account for border + padding
		// Forward to active sub-models.
		m.urlPrompt, _ = m.urlPrompt.Update(msg)
		m.loginModel, _ = m.loginModel.Update(msg)
		m.activeAccess, _ = m.activeAccess.Update(msg)
		m.hostList, _ = m.hostList.Update(msg)
		if m.currentView == viewAccessRequest {
			m.accessRequest, _ = m.accessRequest.Update(msg)
		}
		return m, nil

	case tea.KeyMsg:
		// Global quit.
		if msg.String() == "ctrl+c" {
			return m, tea.Quit
		}

		// Palette is active — route to palette; Enter may run a command.
		if m.palette.Active() {
			return m.updatePalette(msg)
		}

		// / opens the palette (in authenticated views).
		if msg.String() == "/" && m.isAuthenticatedView() {
			m.palette = m.palette.Open("")
			return m, nil
		}

		// ? opens help directly.
		if msg.String() == "?" && m.isAuthenticatedView() {
			m.prevView = m.currentView
			m.currentView = viewHelp
			return m, nil
		}
	}

	// Non-destructive toast messages from any view.
	switch msg := msg.(type) {
	case urlSaveErrMsg:
		logx.Warnf("app: failed to save config after URL entry: %v", msg.err)
		m.toastMsg = fmt.Sprintf("Warning: could not save config: %v", msg.err)

	case hostsErrMsg:
		if errors.Is(msg.err, api.ErrTokenRefreshFailed) {
			logx.Warnf("app: token refresh failed, showing toast: %v", msg.err)
			m.toastMsg = "Warning: token refresh failed — showing cached data. Check your network."
		}
	}

	// Command messages from palette Run functions.
	switch msg.(type) {
	case showHelpMsg:
		m.prevView = m.currentView
		m.currentView = viewHelp
		return m, nil

	case openHostListMsg:
		if m.client == nil {
			m.client = api.New(m.cfg)
		}
		m.prevView = m.currentView
		m.hostList = NewHostListModel(m.client)
		m.currentView = viewHostList
		return m, m.hostList.Init()

	case openRequestMsg:
		// Stub: go to host list so user can pick a server for the request.
		if m.client == nil {
			m.client = api.New(m.cfg)
		}
		m.prevView = m.currentView
		m.hostList = NewHostListModel(m.client)
		m.currentView = viewHostList
		return m, m.hostList.Init()

	case showSessionsMsg:
		m.prevView = m.currentView
		m.currentView = viewSessions
		return m, nil

	case showProfileMsg:
		m.prevView = m.currentView
		m.currentView = viewProfile
		return m, nil

	case forceRefreshMsg:
		// Refresh the current view's data.
		switch m.currentView {
		case viewActiveAccess:
			m.activeAccess.state = activeAccessLoading
			return m, tea.Batch(m.activeAccess.spinner.Tick, m.activeAccess.fetchCmd())
		case viewHostList:
			m.hostList.state = hostListStateLoading
			return m, m.hostList.fetchHosts()
		}
		return m, nil
	}

	// Route to active view.
	switch m.currentView {
	case viewServerURL:
		return m.updateServerURL(msg)
	case viewLogin:
		return m.updateLogin(msg)
	case viewActiveAccess:
		return m.updateActiveAccess(msg)
	case viewHostList:
		return m.updateHostList(msg)
	case viewAccessRequest:
		return m.updateAccessRequest(msg)
	case viewHelp, viewProfile, viewSessions:
		return m.updateOverlay(msg)
	case viewError:
		return m.updateError(msg)
	}

	return m, nil
}

// isAuthenticatedView returns true for views that appear after login.
func (m AppModel) isAuthenticatedView() bool {
	return m.currentView != viewServerURL && m.currentView != viewLogin
}

func (m AppModel) updatePalette(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if msg.String() == "enter" {
		cmd := m.palette.SelectedCommand()
		m.palette = m.palette.Close()
		if cmd != nil {
			return m, cmd.Run(&m)
		}
		return m, nil
	}

	var paletteCmd tea.Cmd
	m.palette, paletteCmd = m.palette.Update(msg)
	return m, paletteCmd
}

func (m AppModel) updateServerURL(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd
	m.urlPrompt, cmd = m.urlPrompt.Update(msg)
	if m.urlPrompt.Done() {
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
		m.client = api.New(m.cfg)
		m.activeAccess = NewActiveAccessModel(m.client)
		m.currentView = viewActiveAccess
		return m, m.activeAccess.Init()
	}

	var cmd tea.Cmd
	m.loginModel, cmd = m.loginModel.Update(msg)
	return m, cmd
}

func (m AppModel) updateActiveAccess(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case activeAccessConnectMsg:
		return m, m.connectFromAR(msg.req)
	}

	var cmd tea.Cmd
	m.activeAccess, cmd = m.activeAccess.Update(msg)
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
		return m, m.connectDirect(msg.host)

	case tea.KeyMsg:
		if msg.String() == "esc" {
			m.currentView = viewActiveAccess
			return m, nil
		}
	}

	var cmd tea.Cmd
	m.hostList, cmd = m.hostList.Update(msg)
	return m, cmd
}

func (m AppModel) updateAccessRequest(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case navBackMsg:
		m.currentView = m.prevView
		if m.currentView == viewActiveAccess || m.currentView == viewError || m.currentView == viewConnecting {
			m.currentView = viewActiveAccess
		}
		return m, nil

	case arApprovedMsg:
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

// updateOverlay handles the simple read-only overlay views (help, profile, sessions).
func (m AppModel) updateOverlay(msg tea.Msg) (tea.Model, tea.Cmd) {
	if kMsg, ok := msg.(tea.KeyMsg); ok {
		switch kMsg.String() {
		case "esc", "q", "enter":
			back := m.prevView
			if back == viewError || back == viewConnecting {
				back = viewActiveAccess
			}
			m.currentView = back
			return m, nil
		}
	}
	return m, nil
}

func (m AppModel) updateError(msg tea.Msg) (tea.Model, tea.Cmd) {
	if kMsg, ok := msg.(tea.KeyMsg); ok {
		switch kMsg.String() {
		case "esc", "q", "enter":
			m.currentView = viewActiveAccess
			return m, nil
		}
	}
	return m, nil
}

// connectFromAR fetches credentials for an approved access request and launches SSH.
func (m AppModel) connectFromAR(req api.AccessRequest) tea.Cmd {
	client := m.client
	return func() tea.Msg {
		creds, err := client.GetSshCredentials(req.ID)
		if err != nil {
			return appErrMsg{err: fmt.Errorf("get SSH credentials: %w", err)}
		}
		// Build a synthetic Host from the inlined server info.
		host := api.Host{ID: req.ServerID}
		if req.Server != nil {
			host.Name = req.Server.DisplayName
			host.Hostname = req.Server.Hostname
			host.Port = req.Server.Port
			host.Environment = req.Server.Environment
			host.Principal = req.Server.SshUser
			host.CustomerName = req.Server.Customer.Name
		}
		if req.RequestedPrincipal != "" {
			host.Principal = req.RequestedPrincipal
		}
		return sshConnectMsg{creds: creds, host: host}
	}
}

// connectDirect fetches credentials for a non-prod host and connects.
func (m AppModel) connectDirect(host api.Host) tea.Cmd {
	client := m.client
	return func() tea.Msg {
		req, err := client.SubmitAccessRequest(host.ID, "Direct access via Shellius TUI", 3600, host.Principal)
		if err != nil {
			return appErrMsg{err: fmt.Errorf("request credentials: %w", err)}
		}
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
// terminal to an SSH subprocess. It records a sessions state file while the
// session is active so other shellius instances can observe it.
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

	// Register the session in the local state dir.
	sess := sessions.Session{
		ServerID:   host.ID,
		ServerName: serverDisplayName(host),
		Principal:  user,
	}
	if creds.ExpiresAt != nil {
		sess.LeaseExpiry = *creds.ExpiresAt
	}
	_, closeSession, sessErr := sessions.Start(sess)
	if sessErr != nil {
		logx.Warnf("app: failed to record session state: %v", sessErr)
		// Non-fatal — continue with SSH anyway.
		closeSession = func() {}
	}

	sshCmd := sshpkg.BuildCommand(hostname, port, user, keyPath, certPath)

	return tea.ExecProcess(sshCmd, func(err error) tea.Msg {
		cleanup()
		closeSession()
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
				return nil
			}
			return appErrMsg{err: fmt.Errorf("SSH session: %w", err)}
		}
		return nil
	})
}

// serverDisplayName returns the best available display name for a host.
func serverDisplayName(h api.Host) string {
	if h.Name != "" {
		return h.Name
	}
	return h.Hostname
}

// View renders the currently active screen.
func (m AppModel) View() string {
	// Pre-login views have no outer border.
	if m.currentView == viewServerURL || m.currentView == viewLogin {
		content := m.renderInner()
		if m.toastMsg != "" {
			content = ToastStyle.Render(m.toastMsg) + "\n" + content
		}
		return content
	}

	// Authenticated views: build header + content + footer, then wrap in border.
	header := m.renderHeader()
	inner := m.renderInner()
	footer := m.renderFooter()

	// If palette is active, overlay it on top of the inner content.
	if m.palette.Active() {
		paletteView := m.palette.View()
		inner = paletteView + "\n" + inner
	}

	// Toast above everything.
	if m.toastMsg != "" {
		inner = ToastStyle.Render(m.toastMsg) + "\n" + inner
	}

	body := header + "\n" + inner + "\n" + footer

	// Outer border sized to terminal width (minus 2 for the border itself).
	borderWidth := m.width - 2
	if borderWidth < 60 {
		borderWidth = 60
	}
	return AppStyle.Width(borderWidth).Render(body)
}

// renderHeader builds the one-line header: "shellius" left, "user@org · url" right.
func (m AppModel) renderHeader() string {
	left := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colorAccent)).Render("shellius")

	var parts []string
	if m.cfg != nil {
		if m.cfg.Username != "" {
			ident := m.cfg.Username
			if m.cfg.OrgSlug != "" {
				ident += "@" + m.cfg.OrgSlug
			}
			parts = append(parts, ident)
		}
		if m.cfg.ServerURL != "" {
			parts = append(parts, m.cfg.ServerURL)
		}
	}

	right := MutedStyle.Render(strings.Join(parts, " · "))

	// Fill gap between left and right.
	leftW := lipgloss.Width(left)
	rightW := lipgloss.Width(right)
	// inner width = borderWidth - 2*padding(1) - 2*border(1) = m.width - 6
	innerW := m.width - 6
	if innerW < 20 {
		innerW = 20
	}
	gap := innerW - leftW - rightW
	if gap < 1 {
		gap = 1
	}
	return left + strings.Repeat(" ", gap) + right
}

// renderFooter returns context-sensitive key hints for the current view.
func (m AppModel) renderFooter() string {
	var hints string
	switch m.currentView {
	case viewActiveAccess:
		hints = "↑↓ select  enter connect  / commands  ? help  ctrl+c quit"
	case viewHostList:
		hints = "↑↓ select  enter connect  esc back  r refresh  ctrl+c quit"
	case viewAccessRequest:
		hints = "tab next  enter submit  esc back  ctrl+c quit"
	case viewHelp:
		hints = "esc / enter close"
	case viewProfile:
		hints = "esc / enter close"
	case viewSessions:
		hints = "esc / enter close"
	case viewError:
		hints = "esc / enter back  ctrl+c quit"
	default:
		hints = "ctrl+c quit"
	}
	return HelpBarStyle.Render(hints)
}

// renderInner delegates to the active view's content renderer.
func (m AppModel) renderInner() string {
	switch m.currentView {
	case viewServerURL:
		return m.urlPrompt.View()
	case viewLogin:
		return m.loginModel.View()
	case viewActiveAccess:
		return m.activeAccess.View()
	case viewHostList:
		return m.hostList.View()
	case viewAccessRequest:
		return m.accessRequest.View()
	case viewHelp:
		return m.renderHelp()
	case viewProfile:
		return m.renderProfile()
	case viewSessions:
		return m.renderSessions()
	case viewConnecting:
		return MutedStyle.Render("Connecting...")
	case viewError:
		return fmt.Sprintf("%s\n\n%s",
			ErrorStyle.Render("Error"),
			MutedStyle.Render(m.errMsg),
		)
	}
	return ""
}

func (m AppModel) renderHelp() string {
	var b strings.Builder
	b.WriteString(TitleStyle.Render("Key bindings"))
	b.WriteString("\n\n")

	rows := [][2]string{
		{"↑ / k", "move up"},
		{"↓ / j", "move down"},
		{"enter", "connect via SSH"},
		{"/", "open command palette"},
		{"?", "this help screen"},
		{"ctrl+c", "quit"},
		{"", ""},
		{"Slash commands:", ""},
		{"/servers", "browse all servers"},
		{"/request", "submit an access request"},
		{"/sessions", "recent sessions"},
		{"/refresh", "force refresh"},
		{"/profile", "identity & token info"},
		{"/logout", "clear credentials & exit"},
		{"/quit", "exit"},
	}

	nameStyle := lipgloss.NewStyle().Width(20).Foreground(lipgloss.Color(colorAccent))
	for _, row := range rows {
		if row[0] == "" && row[1] == "" {
			b.WriteString("\n")
			continue
		}
		if row[1] == "" {
			b.WriteString(SectionHeaderStyle.Render(row[0]))
			b.WriteString("\n")
			continue
		}
		b.WriteString("  ")
		b.WriteString(nameStyle.Render(row[0]))
		b.WriteString(MutedStyle.Render(row[1]))
		b.WriteString("\n")
	}
	return b.String()
}

func (m AppModel) renderProfile() string {
	var b strings.Builder
	b.WriteString(TitleStyle.Render("Profile"))
	b.WriteString("\n\n")

	field := func(label, value string) {
		b.WriteString("  ")
		b.WriteString(InputLabelStyle.Render(fmt.Sprintf("%-18s", label)))
		b.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color(colorText)).Render(value))
		b.WriteString("\n")
	}

	if m.cfg == nil {
		b.WriteString(MutedStyle.Render("  (no config loaded)"))
		return b.String()
	}

	if m.cfg.Username != "" {
		field("User", m.cfg.Username)
	}
	if m.cfg.OrgSlug != "" {
		field("Org", m.cfg.OrgSlug)
	}
	if m.cfg.Role != "" {
		field("Role", m.cfg.Role)
	}
	if m.cfg.ServerURL != "" {
		field("Server URL", m.cfg.ServerURL)
	}
	if !m.cfg.TokenExpiresAt.IsZero() {
		remaining := m.cfg.TokenExpiresAt.Sub(nowFunc())
		if remaining > 0 {
			field("Token expires", formatDuration(remaining)+" from now")
		} else {
			field("Token expires", ErrorStyle.Render("expired (will refresh on next request)"))
		}
	}
	field("Config path", m.cfg.Path())
	return b.String()
}

func (m AppModel) renderSessions() string {
	var b strings.Builder
	b.WriteString(TitleStyle.Render("Sessions"))
	b.WriteString("\n\n")

	// --- Active ---
	active, activeErr := sessions.List()
	b.WriteString(SectionHeaderStyle.Render("ACTIVE"))
	b.WriteString("\n")
	if activeErr != nil {
		b.WriteString(MutedStyle.Render("  (error reading session state: " + activeErr.Error() + ")"))
		b.WriteString("\n")
	} else if len(active) == 0 {
		b.WriteString(MutedStyle.Render("  No active sessions."))
		b.WriteString("\n")
	} else {
		for _, s := range active {
			b.WriteString(m.renderSessionRow(s, true))
			b.WriteString("\n")
		}
	}

	b.WriteString("\n")

	// --- Recent ---
	hist, histErr := sessions.History()
	b.WriteString(SectionHeaderStyle.Render("RECENT"))
	b.WriteString("\n")
	if histErr != nil {
		b.WriteString(MutedStyle.Render("  (error reading history: " + histErr.Error() + ")"))
		b.WriteString("\n")
	} else if len(hist) == 0 {
		b.WriteString(MutedStyle.Render("  No recent sessions."))
		b.WriteString("\n")
	} else {
		for _, s := range hist {
			b.WriteString(m.renderSessionRow(s, false))
			b.WriteString("\n")
		}
	}

	return b.String()
}

func (m AppModel) renderSessionRow(s sessions.Session, isActive bool) string {
	nameCol := lipgloss.NewStyle().Width(22).Render(s.ServerName)
	principalCol := lipgloss.NewStyle().Width(12).
		Foreground(lipgloss.Color(colorSubtle)).
		Render(s.Principal)

	var timeCol string
	if isActive {
		dur := time.Since(s.StartedAt)
		timeCol = "active " + formatDuration(dur)
	} else if !s.EndedAt.IsZero() {
		timeCol = s.EndedAt.Local().Format("01-02 15:04")
	} else {
		timeCol = s.StartedAt.Local().Format("01-02 15:04")
	}
	timeStr := lipgloss.NewStyle().Width(14).
		Foreground(lipgloss.Color(colorMuted)).
		Render(timeCol)

	statusBadge := ""
	if isActive {
		statusBadge = SuccessStyle.Render("live ")
	} else {
		statusBadge = MutedStyle.Render("done ")
	}

	return fmt.Sprintf("  %s  %s  %s  %s", statusBadge, nameCol, principalCol, timeStr)
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
