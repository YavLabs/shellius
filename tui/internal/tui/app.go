package tui

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
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
	viewMyRequests // /myrequests: all my requests across statuses
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
	myRequests    myRequestsModel
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
		if m.currentView == viewMyRequests {
			m.myRequests, _ = m.myRequests.Update(msg)
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

		// q quits from the top-level active-access view only.
		// In sub-views (hostlist, accessrequest, myrequests, overlays) q is handled
		// locally so it can mean "back" without exiting the whole app.
		if msg.String() == "q" && m.currentView == viewActiveAccess {
			return m, tea.Quit
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
		// Go to host list so user can pick a server for the request.
		if m.client == nil {
			m.client = api.New(m.cfg)
		}
		m.prevView = m.currentView
		m.hostList = NewHostListModel(m.client)
		m.currentView = viewHostList
		return m, m.hostList.Init()

	case openMyRequestsMsg:
		if m.client == nil {
			m.client = api.New(m.cfg)
		}
		m.prevView = m.currentView
		m.myRequests = newMyRequestsModel(m.client)
		m.currentView = viewMyRequests
		return m, m.myRequests.Init()

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
		case viewMyRequests:
			m.myRequests.state = myRequestsLoading
			return m, m.myRequests.fetchCmd()
		}
		return m, nil
	}

	// Cross-cutting connection messages. These are produced asynchronously
	// by connectFromAR / the access-request approval flow, and must be
	// handled regardless of which view is currently active — otherwise they
	// get delegated to a sub-model that doesn't know about them and silently
	// dropped (which is exactly what made "Enter" appear to do nothing on
	// the active-access screen in Phase 1).
	switch msg := msg.(type) {
	case sshConnectMsg:
		return m, m.execSSH(msg.creds, msg.host)
	case appErrMsg:
		// A definitive session-expired error means the refresh token has
		// been rejected by the server. There is no in-app recovery — wipe
		// the local credentials and route the user to the login screen
		// with a clear message instead of dumping them in a generic error
		// view they can't escape from.
		if errors.Is(msg.err, api.ErrSessionExpired) {
			logx.Warnf("app: session expired, routing to login screen")
			m.cfg.AccessToken = ""
			m.cfg.RefreshToken = ""
			m.cfg.TokenExpiresAt = time.Time{}
			_ = m.cfg.Save()
			m.client = nil
			m.loginModel = NewLoginModel(m.cfg)
			m.currentView = viewLogin
			m.toastMsg = "Your session has expired — please sign in again."
			return m, m.loginModel.Init()
		}
		m.prevView = m.currentView
		m.currentView = viewError
		m.errMsg = msg.err.Error()
		return m, nil

	case openWebTerminalMsg:
		return m, m.openWebTerminal(msg.url, msg.requestID)
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
	case viewMyRequests:
		return m.updateMyRequests(msg)
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
	case activeAccessErrMsg:
		// Promote session-expired errors to a top-level appErrMsg so the
		// root Update() can wipe creds and route to the login screen.
		if errors.Is(msg.err, api.ErrSessionExpired) {
			return m, func() tea.Msg { return appErrMsg{err: msg.err} }
		}
	}

	var cmd tea.Cmd
	m.activeAccess, cmd = m.activeAccess.Update(msg)
	return m, cmd
}

func (m AppModel) updateHostList(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case hostSelectedMsg:
		// Phase 2: ALWAYS route through the intent/form path regardless of
		// environment. connectDirect has been removed. The form handles the
		// case where hasActiveAccess is true (auto-skip) or hasPendingRequest
		// is true (auto-poll). This ensures the user always sees the form and
		// that no new request is submitted without their knowledge.
		m.selectedHost = msg.host
		m.prevView = m.currentView
		m.currentView = viewAccessRequest
		m.accessRequest = NewAccessRequestModel(m.client, msg.host)
		return m, m.accessRequest.Init()

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
				// If key download is disabled by policy, fall back to web terminal.
				if isKeyDownloadDisabled(err) {
					result, connectErr := client.StartWebTerminal(reqID)
					if connectErr != nil {
						return appErrMsg{err: fmt.Errorf("start web terminal: %w", connectErr)}
					}
					return openWebTerminalMsg{url: result.URL, requestID: reqID}
				}
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

func (m AppModel) updateMyRequests(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg.(type) {
	case navBackMsg:
		back := m.prevView
		if back == viewError || back == viewConnecting {
			back = viewActiveAccess
		}
		m.currentView = back
		return m, nil
	}

	var cmd tea.Cmd
	m.myRequests, cmd = m.myRequests.Update(msg)
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

// openWebTerminalMsg signals that the web terminal should be opened in a browser.
type openWebTerminalMsg struct {
	url       string
	requestID string
}

// openWebTerminal opens the web terminal URL in the system browser and updates
// the access-request sub-model so it renders the confirmation screen.
func (m AppModel) openWebTerminal(url, requestID string) tea.Cmd {
	_ = requestID // reserved for future use (e.g. logging)
	logx.Infof("app: opening web terminal URL: %s", url)

	// Launch browser — fire-and-forget; errors are non-fatal since we still
	// show the URL to the user.
	switch runtime.GOOS {
	case "darwin":
		_ = exec.Command("open", url).Start()
	case "windows":
		_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	default: // linux and others
		_ = exec.Command("xdg-open", url).Start()
	}

	// Update the access-request sub-model to show the confirmation screen.
	return func() tea.Msg {
		return arWebTerminalMsg{url: url}
	}
}

// connectFromAR fetches credentials for an approved access request and launches SSH.
// If key download is disabled by policy (HTTP 403), falls back to opening the
// web terminal URL in the system browser.
func (m AppModel) connectFromAR(req api.AccessRequest) tea.Cmd {
	client := m.client
	return func() tea.Msg {
		creds, err := client.GetSshCredentials(req.ID)
		if err != nil {
			// Key download disabled — fall back to web terminal.
			if isKeyDownloadDisabled(err) {
				result, connectErr := client.StartWebTerminal(req.ID)
				if connectErr != nil {
					return appErrMsg{err: fmt.Errorf("start web terminal: %w", connectErr)}
				}
				return openWebTerminalMsg{url: result.URL, requestID: req.ID}
			}
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
	// Prefer the IP address that the backend resolved when issuing the
	// credentials. The user's local DNS for things like "prod-databases"
	// may point at a completely different host that doesn't trust the
	// Shellius CA — and we'd silently get "Permission denied (publickey)".
	// Hostname is kept for display purposes (logging, error messages).
	hostname := creds.Address
	displayHost := creds.Hostname
	if hostname == "" {
		hostname = creds.Hostname
	}
	if hostname == "" {
		hostname = host.Hostname
	}
	if displayHost == "" {
		displayHost = host.Hostname
	}
	if displayHost != "" && displayHost != hostname {
		logx.Infof("app: connecting to %s (resolved by backend) for display host %s",
			hostname, displayHost)
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

	// Capture ssh's stderr in addition to letting it through to the terminal.
	// Bubble Tea's alt-screen restore wipes whatever ssh printed before
	// failing, so without this tee the user just sees "exit status 255" with
	// no clue why. The buffer is bounded to keep memory predictable on long
	// sessions that emit a lot of output.
	stderrBuf := newBoundedBuffer(8 * 1024)
	sshCmd.Stderr = io.MultiWriter(os.Stderr, stderrBuf)

	logx.Infof("app: launching ssh: host=%s port=%d user=%s keyPath=%s",
		hostname, port, user, keyPath)

	return tea.ExecProcess(sshCmd, func(err error) tea.Msg {
		closeSession()
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
				cleanup()
				return nil
			}
			captured := strings.TrimSpace(stderrBuf.String())
			// Inspect the cert that was just rejected. The cert is still on
			// disk because we deferred cleanup until AFTER diagnostics ran.
			// `ssh-keygen -L -f cert` prints the principals, validity window,
			// signing CA fingerprint, and extensions — exactly what we need
			// to figure out *why* sshd refused it.
			certInfo := inspectCert(certPath)
			// Run a non-interactive ssh -vvv against the same host so we can
			// see whether the cert was actually offered (publickey method) and
			// what authentication methods sshd advertised. BatchMode prevents
			// any password prompts.
			diag := diagnoseSSH(hostname, port, user, keyPath, certPath)
			logx.Warnf("app: ssh exited with error: %v; captured stderr: %s", err, captured)
			logx.Infof("app: cert inspect:\n%s", certInfo)
			logx.Infof("app: ssh -vvv diagnose:\n%s", diag)
			cleanup()
			details := captured
			if certInfo != "" {
				details += "\n\n--- cert ---\n" + certInfo
			}
			if diag != "" {
				details += "\n\n--- ssh -vvv (last lines) ---\n" + diag
			}
			return appErrMsg{err: fmt.Errorf("SSH connection failed (%v):\n%s", err, details)}
		}
		cleanup()
		return nil
	})
}

// inspectCert runs `ssh-keygen -L -f <certPath>` and returns the output. Used
// purely for diagnostics when an ssh connection fails — tells us what
// principals the cert is signed for, what its validity window is, what CA
// signed it, and which key it's bound to.
func inspectCert(certPath string) string {
	cmd := exec.Command("ssh-keygen", "-L", "-f", certPath)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Sprintf("(ssh-keygen -L failed: %v)\n%s", err, string(out))
	}
	return strings.TrimSpace(string(out))
}

// diagnoseSSH runs ssh in batch (non-interactive) mode with -vvv against the
// same host/key/cert and returns the last ~2KB of stderr. This shows whether
// ssh actually offered the cert ("Offering public key") and what sshd's
// response was — far more informative than the bare "Permission denied".
func diagnoseSSH(host string, port int, user, keyPath, certPath string) string {
	args := []string{
		"-vvv",
		"-o", "BatchMode=yes",
		"-o", "StrictHostKeyChecking=no",
		"-o", "UserKnownHostsFile=/dev/null",
		"-o", "ConnectTimeout=10",
		"-o", "CertificateFile=" + certPath,
		"-i", keyPath,
		"-p", fmt.Sprintf("%d", port),
		user + "@" + host,
		"true",
	}
	cmd := exec.Command("ssh", args...)
	out, _ := cmd.CombinedOutput()
	s := string(out)
	if len(s) > 2048 {
		s = s[len(s)-2048:]
	}
	return strings.TrimSpace(s)
}

// boundedBuffer is a tiny ring-style writer that keeps only the last N bytes
// written to it. Used to cap captured ssh stderr at a sane size.
type boundedBuffer struct {
	max int
	buf []byte
}

func newBoundedBuffer(max int) *boundedBuffer {
	return &boundedBuffer{max: max}
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	b.buf = append(b.buf, p...)
	if len(b.buf) > b.max {
		b.buf = b.buf[len(b.buf)-b.max:]
	}
	return len(p), nil
}

func (b *boundedBuffer) String() string { return string(b.buf) }

// serverDisplayName returns the best available display name for a host.
func serverDisplayName(h api.Host) string {
	if h.Name != "" {
		return h.Name
	}
	return h.Hostname
}

// View renders the currently active screen.
func (m AppModel) View() string {
	// Pre-login views: plain, no chrome.
	if m.currentView == viewServerURL || m.currentView == viewLogin {
		content := m.renderInner()
		if m.toastMsg != "" {
			content = ToastStyle.Render("› "+m.toastMsg) + "\n" + content
		}
		return content
	}

	// Authenticated views: header (1 line) + blank + content + footer.
	// No outer border, no separator bar. Content starts at column 0 + 2-space margin.
	header := m.renderHeader()
	inner := m.renderInner()
	footer := m.renderFooter()

	// If palette is active, overlay it on top of the inner content.
	if m.palette.Active() {
		inner = m.palette.View() + "\n" + inner
	}

	// Toast inline, above content.
	if m.toastMsg != "" {
		inner = ToastStyle.Render("› "+m.toastMsg) + "\n" + inner
	}

	return header + "\n\n" + inner + "\n" + footer
}

// innerWidth returns the usable content width.
func (m AppModel) innerWidth() int {
	w := m.width - 4 // 2-space left margin + 2 right buffer
	if w < 40 {
		w = 40
	}
	return w
}

// renderHeader builds the one-line header.
// Format: `shellius · user@org host` — one line, no box, no separator.
func (m AppModel) renderHeader() string {
	wordmark := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colorAccent)).Render("shellius")

	var meta []string
	if m.cfg != nil {
		if m.cfg.Username != "" {
			ident := m.cfg.Username
			if m.cfg.OrgSlug != "" {
				ident += "@" + m.cfg.OrgSlug
			}
			meta = append(meta, ident)
		}
		if m.cfg.ServerURL != "" {
			meta = append(meta, m.cfg.ServerURL)
		}
	}

	bullet := DimStyle.Render(" · ")
	line := wordmark
	if len(meta) > 0 {
		line += bullet + DimStyle.Render(strings.Join(meta, " "))
	}
	return "  " + line
}

// renderFooter returns a single line of dim key hints for the current view.
func (m AppModel) renderFooter() string {
	var hints string
	switch m.currentView {
	case viewActiveAccess:
		hints = "↑↓ select · enter connect · / commands · ? help · q quit"
	case viewHostList:
		hints = "↑↓ select · enter request · esc back · r refresh · / commands"
	case viewAccessRequest:
		hints = "tab next field · enter submit · esc back"
	case viewMyRequests:
		hints = "↑↓ select · r refresh · esc back"
	case viewHelp:
		hints = "esc close"
	case viewProfile:
		hints = "esc close"
	case viewSessions:
		hints = "esc close"
	case viewError:
		hints = "esc back"
	default:
		hints = "ctrl+c quit"
	}
	return "  " + HelpBarStyle.Render(hints)
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
	case viewMyRequests:
		return m.myRequests.View()
	case viewHelp:
		return m.renderHelp()
	case viewProfile:
		return m.renderProfile()
	case viewSessions:
		return m.renderSessions()
	case viewConnecting:
		return "  " + MutedStyle.Render("Connecting...")
	case viewError:
		return fmt.Sprintf("  %s\n\n  %s",
			ErrorStyle.Render("Error"),
			MutedStyle.Render(m.errMsg),
		)
	}
	return ""
}

func (m AppModel) renderHelp() string {
	var b strings.Builder
	b.WriteString("  ")
	b.WriteString(TitleStyle.Render("Key Bindings"))
	b.WriteString("\n\n")

	rows := [][2]string{
		{"↑ / k", "move up"},
		{"↓ / j", "move down"},
		{"enter", "connect / submit"},
		{"/", "open command palette"},
		{"?", "this help screen"},
		{"ctrl+c", "quit"},
		{"", ""},
		{"Commands", ""},
		{"/servers", "browse all servers"},
		{"/request", "submit an access request"},
		{"/myrequests", "view all my requests"},
		{"/sessions", "recent sessions"},
		{"/refresh", "force refresh"},
		{"/profile", "identity and token info"},
		{"/logout", "clear credentials and exit"},
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
	b.WriteString("  ")
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
	b.WriteString("  ")
	b.WriteString(TitleStyle.Render("Sessions"))
	b.WriteString("\n\n")

	// --- Active ---
	active, activeErr := sessions.List()
	b.WriteString(SectionHeaderStyle.Render("Active"))
	b.WriteString("\n")
	if activeErr != nil {
		b.WriteString(MutedStyle.Render("  (error reading session state: " + activeErr.Error() + ")"))
		b.WriteString("\n")
	} else if len(active) == 0 {
		b.WriteString(MutedStyle.Render("  no active sessions"))
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
	b.WriteString(SectionHeaderStyle.Render("Recent"))
	b.WriteString("\n")
	if histErr != nil {
		b.WriteString(MutedStyle.Render("  (error reading history: " + histErr.Error() + ")"))
		b.WriteString("\n")
	} else if len(hist) == 0 {
		b.WriteString(MutedStyle.Render("  no recent sessions"))
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
