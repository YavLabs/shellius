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
	requests []api.AccessRequest
	fromCache bool
}

// activeAccessErrMsg carries a fetch error.
type activeAccessErrMsg struct{ err error }

// activeAccessRefreshTick signals it is time for a background refresh.
type activeAccessRefreshTick struct{}

// activeAccessCacheHintExpired hides the "cached" footer hint after ~5s.
type activeAccessCacheHintExpired struct{}

// activeAccessConnectMsg requests that the app exec SSH for this access request.
type activeAccessConnectMsg struct {
	req api.AccessRequest
}

const activeAccessRefreshInterval = 30 * time.Second

// activeAccessModel is the default post-login view: my currently approved
// access requests with an instant-SSH Enter key.
type activeAccessModel struct {
	client     *api.Client
	state      activeAccessState
	requests   []api.AccessRequest
	filtered   []api.AccessRequest
	cursor     int
	filter     textinput.Model
	spinner    spinner.Model
	errMsg     string
	width      int
	height     int
	// cacheHint is the footer annotation shown briefly after painting from cache.
	// "" = no hint, "cached" = show cached badge, "stale" = network error
	cacheHint string
}

// NewActiveAccessModel creates the active-access picker model.
func NewActiveAccessModel(client *api.Client) activeAccessModel {
	ti := textinput.New()
	ti.Placeholder = "filter..."
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
			// Return a pre-populated loaded msg so the UI is instant.
			cmds = append(cmds, func() tea.Msg {
				return activeAccessLoadedMsg{requests: reqs, fromCache: true}
			})
			// Schedule a background reconciliation fetch.
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
		// Persist to cache.
		if data, mErr := json.Marshal(reqs); mErr == nil {
			_ = cache.Write(activeAccessCacheName, data, "")
		}
		return activeAccessLoadedMsg{requests: reqs, fromCache: false}
	}
}

// backgroundFetchCmd performs a silent network fetch to reconcile cache.
// It does NOT switch to the loading state even if it runs before the
// cache-served message is processed.
func (m activeAccessModel) backgroundFetchCmd() tea.Cmd {
	client := m.client
	return func() tea.Msg {
		reqs, err := client.ListMyActiveAccessRequests()
		if err != nil {
			logx.Warnf("activeaccess: background refresh failed: %v", err)
			// Signal stale-network so the UI can add a hint but keep the data.
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

// scheduleCacheHintExpiry hides the cache hint after 5 seconds.
func scheduleCacheHintExpiry() tea.Cmd {
	return tea.Tick(5*time.Second, func(_ time.Time) tea.Msg {
		return activeAccessCacheHintExpired{}
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

	case activeAccessCacheHintExpired:
		// Only clear if we're still showing the "cached" hint — not "stale".
		if m.cacheHint == "cached" {
			m.cacheHint = ""
		}
		return m, nil

	case activeAccessLoadedMsg:
		m.requests = msg.requests
		m.state = activeAccessReady
		m.applyFilter()
		// Keep cursor in bounds.
		if m.cursor >= len(m.filtered) {
			m.cursor = max(0, len(m.filtered)-1)
		}
		if m.state == activeAccessReady && !m.filter.Focused() {
			m.filter.Focus()
		}

		var cmds []tea.Cmd
		cmds = append(cmds, m.scheduleRefresh())

		if msg.fromCache {
			m.cacheHint = "cached"
			cmds = append(cmds, scheduleCacheHintExpiry())
		} else {
			// Fresh data arrived — clear any stale hint.
			m.cacheHint = ""
		}
		return m, tea.Batch(cmds...)

	case activeAccessErrMsg:
		// If we already have data (from cache), don't switch to error state —
		// just annotate with a stale hint.
		if m.state == activeAccessReady {
			m.cacheHint = "stale"
			return m, nil
		}
		m.state = activeAccessError
		m.errMsg = msg.err.Error()
		return m, nil

	case activeAccessRefreshTick:
		// Background refresh — don't switch back to loading state.
		return m, m.fetchCmd()

	case tea.KeyMsg:
		if m.state != activeAccessReady {
			return m, nil
		}
		switch msg.String() {
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
	}

	// Delegate to filter input.
	if m.state == activeAccessReady {
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

// visibleRows returns how many list rows fit in the current terminal height.
func (m activeAccessModel) visibleRows() int {
	// Reserve: header(1) + blank(1) + section-label(1) + filter(1) + blank(1) + footer(1) + border(2) = 8
	reserved := 8
	v := m.height - reserved
	if v < 3 {
		v = 3
	}
	return v
}

func (m activeAccessModel) View() string {
	var b strings.Builder

	switch m.state {
	case activeAccessLoading:
		b.WriteString("\n  ")
		b.WriteString(m.spinner.View())
		b.WriteString("  ")
		b.WriteString(MutedStyle.Render("Loading active access..."))
		b.WriteString("\n")

	case activeAccessError:
		b.WriteString("\n  ")
		b.WriteString(ErrorStyle.Render("Error: "))
		b.WriteString(MutedStyle.Render(m.errMsg))
		b.WriteString("\n\n  ")
		b.WriteString(HelpBarStyle.Render("press r to retry  /  press / for commands"))
		b.WriteString("\n")

	case activeAccessReady:
		b.WriteString(m.renderReady())
	}

	return b.String()
}

func (m activeAccessModel) renderReady() string {
	var b strings.Builder

	// Section label
	countLabel := fmt.Sprintf("%d active", len(m.requests))
	if len(m.requests) == 0 {
		countLabel = "none"
	}
	b.WriteString("  ")
	b.WriteString(SectionHeaderStyle.Render("ACTIVE ACCESS"))
	b.WriteString("  ")
	b.WriteString(MutedStyle.Render(countLabel))

	// Cache hint (briefly shown after painting from cache, or on stale network).
	if m.cacheHint == "cached" {
		b.WriteString("  ")
		b.WriteString(MutedStyle.Render("[cached]"))
	} else if m.cacheHint == "stale" {
		b.WriteString("  ")
		b.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color(colorStaging)).Render("[stale, network error]"))
	}
	b.WriteString("\n")

	// Filter input
	b.WriteString("  ")
	b.WriteString(m.filter.View())
	b.WriteString("\n\n")

	if len(m.filtered) == 0 {
		if len(m.requests) == 0 {
			b.WriteString("  ")
			b.WriteString(MutedStyle.Render("No active access. Press / and choose /request."))
		} else {
			b.WriteString("  ")
			b.WriteString(MutedStyle.Render("No results for your filter."))
		}
		b.WriteString("\n")
		return b.String()
	}

	// Rows
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
		r := m.filtered[i]
		selected := i == m.cursor
		b.WriteString(m.renderRow(r, selected))
		b.WriteString("\n")
	}

	// Scroll indicator
	if len(m.filtered) > visible {
		scrollInfo := fmt.Sprintf("  %d-%d of %d", start+1, end, len(m.filtered))
		b.WriteString(MutedStyle.Render(scrollInfo))
		b.WriteString("\n")
	}

	return b.String()
}

func (m activeAccessModel) renderRow(r api.AccessRequest, selected bool) string {
	env := envFromAR(r)
	badge := EnvBadge(env)

	name := serverNameFromAR(r)
	principal := r.RequestedPrincipal
	if principal == "" && r.Server != nil {
		principal = r.Server.SshUser
	}
	if principal == "" {
		principal = "ubuntu"
	}

	var expiryStr string
	if r.ExpiresAt != nil {
		remaining := time.Until(*r.ExpiresAt)
		if remaining > 0 {
			expiryStr = "expires in " + formatDuration(remaining)
		} else {
			expiryStr = "expired"
		}
	}

	// Build content: badge  name  principal  expiry  [enter] ssh
	nameCol := lipgloss.NewStyle().Width(22).Render(name)
	principalCol := lipgloss.NewStyle().Width(12).
		Foreground(lipgloss.Color(colorSubtle)).
		Render(principal)
	expiryCol := lipgloss.NewStyle().Width(18).
		Foreground(lipgloss.Color(colorMuted)).
		Render(expiryStr)

	hint := ""
	if selected {
		hint = HelpBarStyle.Render("  [enter] ssh")
	}

	content := fmt.Sprintf("  %-6s  %s  %s  %s%s",
		badge,
		nameCol,
		principalCol,
		expiryCol,
		hint,
	)

	if selected {
		return SelectedItemStyle.Render(content)
	}
	return ListItemStyle.Render(content)
}
