package tui

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/shellius/tui/internal/api"
	"github.com/shellius/tui/internal/cache"
	"github.com/shellius/tui/internal/logx"
)

const activeAccessCacheName = "active-access.json"
const activeAccessCacheTTL = 15 * time.Minute

// activeAccessState tracks the loading lifecycle of the active-access picker.
type activeAccessState int

const (
	activeAccessLoading activeAccessState = iota
	activeAccessReady
	activeAccessError
)

// activeAccessLoadedMsg carries the fetched access requests.
type activeAccessLoadedMsg struct {
	requests  []api.AccessRequest
	fromCache bool
}

// activeAccessErrMsg carries a fetch error.
type activeAccessErrMsg struct{ err error }

// activeAccessRefreshTick signals it is time for a background refresh.
type activeAccessRefreshTick struct{}

// activeAccessConnectMsg requests that the app exec SSH for this access request.
type activeAccessConnectMsg struct {
	req api.AccessRequest
}

const activeAccessRefreshInterval = 30 * time.Second

// activeAccessModel is the default post-login view: my currently approved
// access requests with an instant-SSH Enter key.
type activeAccessModel struct {
	client   *api.Client
	state    activeAccessState
	requests []api.AccessRequest
	filtered []api.AccessRequest
	cursor   int
	filter   textinput.Model
	spinner  spinner.Model
	errMsg   string
	width    int
	height   int
}

// NewActiveAccessModel creates the active-access picker model.
func NewActiveAccessModel(client *api.Client) activeAccessModel {
	ti := textinput.New()
	ti.Placeholder = "filter active access..."
	ti.CharLimit = 64
	ti.Width = 32

	s := spinner.New()
	s.Spinner = spinner.Dot
	s.Style = lipgloss.NewStyle().Foreground(lipgloss.Color(colorAccent))

	return activeAccessModel{
		client:  client,
		state:   activeAccessLoading,
		filter:  ti,
		spinner: s,
	}
}

// Init starts the initial fetch and spinner. If a warm cache exists it paints
// immediately while a background network fetch reconciles the data.
func (m activeAccessModel) Init() tea.Cmd {
	cmds := []tea.Cmd{m.spinner.Tick}

	// Try to serve from cache immediately.
	cachedData, _, ok := cache.Read(activeAccessCacheName, activeAccessCacheTTL)
	if ok && len(cachedData) > 0 {
		var reqs []api.AccessRequest
		if err := json.Unmarshal(cachedData, &reqs); err == nil {
			logx.Infof("activeaccess: painting from cache (%d entries)", len(reqs))
			cmds = append(cmds, func() tea.Msg {
				return activeAccessLoadedMsg{requests: reqs, fromCache: true}
			})
			cmds = append(cmds, m.backgroundFetchCmd())
			return tea.Batch(cmds...)
		}
	}

	// No warm cache — normal blocking fetch.
	cmds = append(cmds, m.fetchCmd())
	return tea.Batch(cmds...)
}

// fetchCmd performs a live network fetch and updates the cache on success.
func (m activeAccessModel) fetchCmd() tea.Cmd {
	client := m.client
	return func() tea.Msg {
		reqs, err := client.ListMyActiveAccessRequests()
		if err != nil {
			return activeAccessErrMsg{err: err}
		}
		if data, mErr := json.Marshal(reqs); mErr == nil {
			_ = cache.Write(activeAccessCacheName, data, "")
		}
		return activeAccessLoadedMsg{requests: reqs, fromCache: false}
	}
}

// backgroundFetchCmd performs a silent network fetch to reconcile cache.
func (m activeAccessModel) backgroundFetchCmd() tea.Cmd {
	client := m.client
	return func() tea.Msg {
		reqs, err := client.ListMyActiveAccessRequests()
		if err != nil {
			logx.Warnf("activeaccess: background refresh failed: %v", err)
			return activeAccessErrMsg{err: err}
		}
		if data, mErr := json.Marshal(reqs); mErr == nil {
			_ = cache.Write(activeAccessCacheName, data, "")
		}
		return activeAccessLoadedMsg{requests: reqs, fromCache: false}
	}
}

// scheduleRefresh returns a command that fires activeAccessRefreshTick after
// the refresh interval, then triggers a re-fetch.
func (m activeAccessModel) scheduleRefresh() tea.Cmd {
	return tea.Tick(activeAccessRefreshInterval, func(_ time.Time) tea.Msg {
		return activeAccessRefreshTick{}
	})
}

func (m activeAccessModel) Update(msg tea.Msg) (activeAccessModel, tea.Cmd) {
	switch msg := msg.(type) {

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height

	case spinner.TickMsg:
		if m.state == activeAccessLoading {
			var cmd tea.Cmd
			m.spinner, cmd = m.spinner.Update(msg)
			return m, cmd
		}

	case activeAccessLoadedMsg:
		m.requests = msg.requests
		m.state = activeAccessReady
		m.applyFilter()
		if m.cursor >= len(m.filtered) {
			m.cursor = max(0, len(m.filtered)-1)
		}
		if m.state == activeAccessReady && !m.filter.Focused() {
			m.filter.Focus()
		}

		var cmds []tea.Cmd
		cmds = append(cmds, m.scheduleRefresh())
		return m, tea.Batch(cmds...)

	case activeAccessErrMsg:
		m.errMsg = msg.err.Error()
		logx.Warnf("activeaccess: fetch failed: %v", msg.err)
		if m.state == activeAccessReady {
			return m, nil
		}
		m.state = activeAccessError
		return m, nil

	case activeAccessRefreshTick:
		return m, m.fetchCmd()

	case tea.KeyMsg:
		if m.state != activeAccessReady {
			return m, nil
		}
		key := msg.String()
		switch key {
		case "up", "k":
			if m.cursor > 0 {
				m.cursor--
			}
			return m, nil

		case "down", "j":
			if m.cursor < len(m.filtered)-1 {
				m.cursor++
			}
			return m, nil

		case "g":
			m.cursor = 0
			return m, nil

		case "G":
			if len(m.filtered) > 0 {
				m.cursor = len(m.filtered) - 1
			}
			return m, nil

		case "enter":
			if len(m.filtered) > 0 && m.cursor < len(m.filtered) {
				req := m.filtered[m.cursor]
				return m, func() tea.Msg { return activeAccessConnectMsg{req: req} }
			}
			return m, nil

		case "r", "ctrl+r":
			m.state = activeAccessLoading
			return m, tea.Batch(m.spinner.Tick, m.fetchCmd())
		}

		// H21: Key fall-through guard — only editing/printable keys reach the textinput.
		// Unrecognized navigation keys (esc, tab, page-up, function keys, etc.) are a
		// no-op so the textinput can't silently swallow them.
		switch key {
		case "backspace", "delete", "left", "right", "home", "end", "ctrl+u", "ctrl+w":
			// editing keys — forward
		default:
			if len(msg.Runes) == 0 {
				return m, nil
			}
		}
		var cmd tea.Cmd
		m.filter, cmd = m.filter.Update(msg)
		m.applyFilter()
		if m.cursor >= len(m.filtered) {
			m.cursor = max(0, len(m.filtered)-1)
		}
		return m, cmd
	}

	return m, nil
}

func (m *activeAccessModel) applyFilter() {
	q := strings.ToLower(strings.TrimSpace(m.filter.Value()))
	if q == "" {
		m.filtered = m.requests
		return
	}
	var out []api.AccessRequest
	for _, r := range m.requests {
		haystack := strings.ToLower(serverNameFromAR(r) + " " + r.RequestedPrincipal)
		if r.Server != nil {
			haystack += " " + strings.ToLower(r.Server.Environment)
			haystack += " " + strings.ToLower(r.Server.Customer.Name)
		}
		if fuzzyMatch(q, haystack) {
			out = append(out, r)
		}
	}
	m.filtered = out
}

// serverNameFromAR returns a display name for an access request's server.
func serverNameFromAR(r api.AccessRequest) string {
	if r.Server != nil {
		if r.Server.DisplayName != "" {
			return r.Server.DisplayName
		}
		return r.Server.Hostname
	}
	return r.ServerID
}

// envFromAR returns the environment string for an access request.
func envFromAR(r api.AccessRequest) string {
	if r.Server != nil {
		return r.Server.Environment
	}
	return ""
}

// customerFromAR returns the customer name for an access request.
func customerFromAR(r api.AccessRequest) string {
	if r.Server != nil {
		return r.Server.Customer.Name
	}
	return ""
}

// innerWidth returns the usable panel inner width.
func (m activeAccessModel) innerWidth() int {
	w := m.width
	if w < 60 {
		w = 60
	}
	if w > 120 {
		w = 120
	}
	// subtract border(2) + padding(2)
	return w - 4
}

// panelHeight returns how many lines the panel body can hold.
// Reserve: header-line(1) + blank(1) + search(1) + sort(1) + blank(1) +
//          colheader(1) + sep(1) + count(1) + border(2) + app-footer(1) = 11
// Logo adds 7 lines (6 art + 1 blank) when shown.
func (m activeAccessModel) visibleRows() int {
	overhead := 11
	if m.height >= 28 {
		overhead += 7 // logo
	}
	v := m.height - overhead
	if v < 3 {
		v = 3
	}
	return v
}

// View renders the active access screen with sshm-style panel.
func (m activeAccessModel) View() string {
	iw := m.innerWidth()
	var bodyLines []string

	showLogo := m.height >= 28

	switch m.state {
	case activeAccessLoading:
		spinner := m.spinner.View() + " " + MutedStyle.Render("loading active access...")
		bodyLines = append(bodyLines, spinner)

	case activeAccessError:
		bodyLines = append(bodyLines,
			ErrorStyle.Render("error:")+" "+MutedStyle.Render(m.errMsg),
			HelpBarStyle.Render("r retry  ·  / commands"),
		)

	case activeAccessReady:
		if showLogo {
			// Logo lines (6 lines of art)
			logoLines := strings.Split(strings.TrimRight(ShelliusLogo(), "\n"), "\n")
			bodyLines = append(bodyLines, logoLines...)
			bodyLines = append(bodyLines, "")
		}

		// Search bar: "Search (/ to focus): › <input>"
		searchLine := SearchBarLabel() + m.filter.View()
		bodyLines = append(bodyLines, searchLine)

		// Sort indicator
		bodyLines = append(bodyLines, SortIndicator("expires"))
		bodyLines = append(bodyLines, "")

		// Column headers
		hdr := m.renderHeaderRow(iw)
		bodyLines = append(bodyLines, hdr)
		bodyLines = append(bodyLines, TableHeaderSep(iw))

		if len(m.filtered) == 0 {
			if len(m.requests) == 0 {
				bodyLines = append(bodyLines, DimStyle.Render("no active access — press / and choose /request"))
			} else {
				bodyLines = append(bodyLines, DimStyle.Render("no results for your filter"))
			}
		} else {
			visible := m.visibleRows()
			start := 0
			if m.cursor >= visible {
				start = m.cursor - visible + 1
			}
			end := start + visible
			if end > len(m.filtered) {
				end = len(m.filtered)
			}

			for i := start; i < end; i++ {
				row := m.renderRow(m.filtered[i], i == m.cursor, iw)
				bodyLines = append(bodyLines, row)
			}
		}

		// Count line
		countLine := DimStyle.Render(fmt.Sprintf("%d active access request", len(m.filtered)))
		if len(m.filtered) != 1 {
			countLine = DimStyle.Render(fmt.Sprintf("%d active access requests", len(m.filtered)))
		}
		bodyLines = append(bodyLines, "")
		bodyLines = append(bodyLines, countLine)
	}

	body := strings.Join(bodyLines, "\n")
	panelWidth := m.width - 4 // leave 2-space margin each side
	if panelWidth < 56 {
		panelWidth = 56
	}
	if panelWidth > 116 {
		panelWidth = 116
	}
	return RoundedPanel(body, panelWidth)
}

func (m activeAccessModel) renderHeaderRow(iw int) string {
	// Columns: Env(8) Customer(18) Server(18) Principal(12) Expires(10)
	env := TableHeaderStyle.Width(8).Render("Env")
	cust := TableHeaderStyle.Width(18).Render("Customer")
	server := TableHeaderStyle.Width(18).Render("Server")
	principal := TableHeaderStyle.Width(12).Render("Principal")
	expires := TableHeaderStyle.Render("Expires")
	_ = iw
	return env + " " + cust + " " + server + " " + principal + " " + expires
}

func (m activeAccessModel) renderRow(r api.AccessRequest, selected bool, iw int) string {
	env := envFromAR(r)
	envStr := EnvBadge(env)

	customer := customerFromAR(r)
	custCol := lipgloss.NewStyle().Width(18).Foreground(lipgloss.Color(colorMuted)).Render(truncate(customer, 17))

	name := serverNameFromAR(r)
	serverCol := lipgloss.NewStyle().Width(18).Foreground(lipgloss.Color(colorText)).Render(truncate(name, 17))

	principal := r.RequestedPrincipal
	if principal == "" && r.Server != nil {
		principal = r.Server.SshUser
	}
	if principal == "" {
		principal = "ubuntu"
	}
	principalCol := lipgloss.NewStyle().Width(12).Foreground(lipgloss.Color(colorMuted)).Render(truncate(principal, 11))

	var expiryStr string
	if r.ExpiresAt != nil {
		remaining := time.Until(*r.ExpiresAt)
		if remaining > 0 {
			expiryStr = formatDuration(remaining)
		} else {
			expiryStr = "expired"
		}
	}
	expiryCol := lipgloss.NewStyle().Width(10).Foreground(lipgloss.Color(colorMuted)).Render(expiryStr)

	content := envStr + " " + custCol + " " + serverCol + " " + principalCol + " " + expiryCol

	if selected {
		return renderSelectedRow(content, iw)
	}
	return renderNormalRow(content)
}

// truncate cuts s to max runes, appending "…" if needed.
func truncate(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	if max <= 1 {
		return "…"
	}
	return string(runes[:max-1]) + "…"
}
