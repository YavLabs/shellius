package tui

import (
	"fmt"
	"sort"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/shellius/tui/internal/api"
)

// hostListState tracks what the hostlist view is doing.
type hostListState int

const (
	hostListStateLoading hostListState = iota
	hostListStateReady
	hostListStateError
)

// hostsLoadedMsg carries the result of the host fetch.
type hostsLoadedMsg struct {
	hosts []api.Host
}

// hostsErrMsg carries a host-fetch error.
type hostsErrMsg struct{ err error }

// hostSelectedMsg is sent when the user picks a host.
// The parent app always routes through the intent/form flow — never directly
// connecting without a form (Phase 2 invariant: connectDirect is removed).
type hostSelectedMsg struct{ host api.Host }

// HostListModel is the Bubble Tea model for the filterable host list.
type HostListModel struct {
	client    *api.Client
	state     hostListState
	allHosts  []api.Host
	filtered  []api.Host
	cursor    int
	filter    textinput.Model
	errMsg    string
	width     int
	height    int
	// visibleStart is the index of the first visible item (for scrolling).
	visibleStart int
}

// NewHostListModel creates the host list model.
func NewHostListModel(client *api.Client) HostListModel {
	ti := textinput.New()
	ti.Placeholder = "filter hosts..."
	ti.CharLimit = 128
	ti.Width = 40

	return HostListModel{
		client: client,
		state:  hostListStateLoading,
		filter: ti,
	}
}

// Init kicks off the host fetch.
func (m HostListModel) Init() tea.Cmd {
	return m.fetchHosts()
}

func (m HostListModel) fetchHosts() tea.Cmd {
	return func() tea.Msg {
		hosts, err := m.client.ListHosts()
		if err != nil {
			return hostsErrMsg{err: err}
		}
		return hostsLoadedMsg{hosts: hosts}
	}
}

func (m HostListModel) Update(msg tea.Msg) (HostListModel, tea.Cmd) {
	switch msg := msg.(type) {

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height

	case hostsLoadedMsg:
		m.allHosts = msg.hosts
		m.filtered = msg.hosts
		m.state = hostListStateReady
		m.cursor = 0
		m.visibleStart = 0
		focusCmd := m.filter.Focus()
		return m, focusCmd

	case hostsErrMsg:
		m.state = hostListStateError
		m.errMsg = msg.err.Error()
		return m, nil

	case tea.KeyMsg:
		if m.state != hostListStateReady {
			return m, nil
		}
		switch msg.String() {
		case "up", "k":
			if m.cursor > 0 {
				m.cursor--
				if m.cursor < m.visibleStart {
					m.visibleStart = m.cursor
				}
			}
			return m, nil

		case "down", "j":
			if m.cursor < len(m.filtered)-1 {
				m.cursor++
				visible := m.visibleRows()
				if m.cursor >= m.visibleStart+visible {
					m.visibleStart = m.cursor - visible + 1
				}
			}
			return m, nil

		case "enter":
			if len(m.filtered) > 0 && m.cursor < len(m.filtered) {
				host := m.filtered[m.cursor]
				// Always emit hostSelectedMsg — the parent routes through
				// intent / form regardless of environment. connectDirect
				// has been removed in Phase 2.
				return m, func() tea.Msg { return hostSelectedMsg{host: host} }
			}
			return m, nil

		case "r", "ctrl+r":
			m.state = hostListStateLoading
			m.allHosts = nil
			m.filtered = nil
			m.cursor = 0
			m.visibleStart = 0
			return m, m.fetchHosts()
		}

		// Editing/printable keys go to the filter; everything else is a
		// no-op so we don't accidentally feed escape sequences or function
		// keys into the textinput.
		switch msg.String() {
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
		m.visibleStart = 0
		return m, cmd
	}

	return m, nil
}

func (m *HostListModel) applyFilter() {
	q := strings.ToLower(strings.TrimSpace(m.filter.Value()))
	if q == "" {
		m.filtered = m.allHosts
		return
	}
	var out []api.Host
	for _, h := range m.allHosts {
		haystack := strings.ToLower(h.Name + " " + h.Hostname + " " + h.CustomerName + " " + h.Environment)
		if fuzzyMatch(q, haystack) {
			out = append(out, h)
		}
	}
	m.filtered = out
}

// fuzzyMatch returns true if every character in needle appears in haystack in order.
func fuzzyMatch(needle, haystack string) bool {
	hi := 0
	for _, ch := range needle {
		found := false
		for hi < len(haystack) {
			if rune(haystack[hi]) == ch {
				hi++
				found = true
				break
			}
			hi++
		}
		if !found {
			return false
		}
	}
	return true
}

func (m HostListModel) visibleRows() int {
	// Reserve rows: title(2) + filter(2) + help(2) + statusbar(1) + padding(2).
	reserved := 9
	v := m.height - reserved
	if v < 5 {
		v = 5
	}
	return v
}

// groupByCustomer groups the hosts by CustomerName, preserving insertion order
// of first occurrence.
func groupByCustomer(hosts []api.Host) ([]string, map[string][]api.Host) {
	order := []string{}
	seen := map[string]bool{}
	groups := map[string][]api.Host{}

	for _, h := range hosts {
		if !seen[h.CustomerName] {
			seen[h.CustomerName] = true
			order = append(order, h.CustomerName)
		}
		groups[h.CustomerName] = append(groups[h.CustomerName], h)
	}
	sort.Strings(order)
	return order, groups
}

func (m HostListModel) View() string {
	var b strings.Builder

	// Section title: "Hosts (N)" bold + count dim.
	b.WriteString("  ")
	b.WriteString(SectionHeaderStyle.Render("Hosts"))
	b.WriteString(DimStyle.Render(fmt.Sprintf(" (%d)", len(m.allHosts))))
	b.WriteString("\n")
	b.WriteString("  ")
	b.WriteString(m.filter.View())
	b.WriteString("\n\n")

	switch m.state {
	case hostListStateLoading:
		b.WriteString("  ")
		b.WriteString(MutedStyle.Render("loading hosts..."))

	case hostListStateError:
		b.WriteString("  ")
		b.WriteString(ErrorStyle.Render("error: "))
		b.WriteString(MutedStyle.Render(m.errMsg))
		b.WriteString("\n  ")
		b.WriteString(HelpBarStyle.Render("r retry"))

	case hostListStateReady:
		if len(m.filtered) == 0 {
			b.WriteString("  ")
			b.WriteString(MutedStyle.Render("no hosts match your filter"))
		} else {
			b.WriteString(m.renderList())
		}
	}

	return b.String()
}

func (m HostListModel) renderList() string {
	var b strings.Builder

	customerOrder, groups := groupByCustomer(m.filtered)
	visible := m.visibleRows()

	// Build a flat index of all items so we can map global cursor to items.
	type flatItem struct {
		isHeader bool
		customer string
		host     api.Host
	}
	var flat []flatItem
	for _, cust := range customerOrder {
		flat = append(flat, flatItem{isHeader: true, customer: cust})
		for _, h := range groups[cust] {
			flat = append(flat, flatItem{host: h})
		}
	}

	// Determine which flat items contain actual hosts (for cursor tracking).
	// m.cursor tracks position in m.filtered (host-only list).
	// We need to figure out which flat index corresponds to cursor host.
	hostFlatIdx := map[int]int{} // filtered index → flat index
	fi := 0
	hi := 0
	for _, item := range flat {
		if !item.isHeader {
			hostFlatIdx[hi] = fi
			hi++
		}
		fi++
	}

	// Compute first visible flat index from visibleStart (host index).
	firstFlatVisible := 0
	if m.visibleStart > 0 {
		if idx, ok := hostFlatIdx[m.visibleStart]; ok {
			firstFlatVisible = idx
		}
	}

	rowsRendered := 0
	currentHostIdx := 0
	for idx, item := range flat {
		if idx < firstFlatVisible {
			if !item.isHeader {
				currentHostIdx++
			}
			continue
		}
		if rowsRendered >= visible {
			break
		}
		if item.isHeader {
			// Customer group header — muted, not bold (section title above the list is bold).
			b.WriteString("  ")
			b.WriteString(DimStyle.Render(item.customer))
			b.WriteString("\n")
			rowsRendered++
			continue
		}

		selected := currentHostIdx == m.cursor
		b.WriteString(m.renderHostRow(item.host, selected))
		b.WriteString("\n")
		rowsRendered++
		currentHostIdx++
	}

	// Scroll indicator.
	if len(m.filtered) > visible {
		scrollInfo := fmt.Sprintf("  %d-%d of %d",
			m.visibleStart+1,
			min(m.visibleStart+visible, len(m.filtered)),
			len(m.filtered),
		)
		b.WriteString(MutedStyle.Render(scrollInfo))
		b.WriteString("\n")
	}

	return b.String()
}

func (m HostListModel) renderHostRow(h api.Host, selected bool) string {
	badge := EnvBadge(h.Environment)
	status := AccessStatusStyle(h.AccessStatus)

	var expiry string
	if h.AccessExpiry != nil {
		d := h.AccessExpiry.Sub(nowFunc())
		if d > 0 {
			expiry = DimStyle.Render(fmt.Sprintf("  expires %s", formatDuration(d)))
		}
	}

	name := h.Name
	if name == "" {
		name = h.Hostname
	}

	nameCol := lipgloss.NewStyle().Width(28).
		Foreground(lipgloss.Color(colorPrimary)).
		Render(name)
	content := badge + "  " + nameCol + "  " + status + expiry

	if selected {
		return renderSelectedRow(content)
	}
	return renderNormalRow(content)
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
