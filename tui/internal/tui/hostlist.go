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
// The parent app always routes through the intent/form flow.
type hostSelectedMsg struct{ host api.Host }

// HostListModel is the Bubble Tea model for the filterable host list.
type HostListModel struct {
	client       *api.Client
	state        hostListState
	allHosts     []api.Host
	filtered     []api.Host
	cursor       int
	filter       textinput.Model
	errMsg       string
	width        int
	height       int
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

		case "g":
			m.cursor = 0
			m.visibleStart = 0
			return m, nil

		case "G":
			if len(m.filtered) > 0 {
				m.cursor = len(m.filtered) - 1
				visible := m.visibleRows()
				if m.cursor >= visible {
					m.visibleStart = m.cursor - visible + 1
				}
			}
			return m, nil

		case "enter":
			if len(m.filtered) > 0 && m.cursor < len(m.filtered) {
				host := m.filtered[m.cursor]
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

		// H22: Key fall-through guard — editing/printable keys only reach the textinput.
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
	// Reserve: search(1) + sort(1) + blank(1) + colheader(1) + sep(1) + count(1) +
	//          border(2) + app-header(2) + app-footer(1) = 11
	reserved := 11
	v := m.height - reserved
	if v < 5 {
		v = 5
	}
	return v
}

// innerWidth returns the usable panel content width. Expands to fill the
// terminal — no upper cap, so wide windows don't waste right-side gutter.
func (m HostListModel) innerWidth() int {
	w := m.width - 4
	if w < 56 {
		w = 56
	}
	return w
}

// groupByCustomer groups the hosts by CustomerName.
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
	iw := m.innerWidth()
	var bodyLines []string

	// Search bar
	searchLine := SearchBarLabel() + m.filter.View()
	bodyLines = append(bodyLines, searchLine)
	bodyLines = append(bodyLines, SortIndicator("name"))
	bodyLines = append(bodyLines, "")

	switch m.state {
	case hostListStateLoading:
		bodyLines = append(bodyLines, MutedStyle.Render("loading hosts..."))

	case hostListStateError:
		bodyLines = append(bodyLines,
			ErrorStyle.Render("error: ")+MutedStyle.Render(m.errMsg),
			HelpBarStyle.Render("r retry"),
		)

	case hostListStateReady:
		// Column headers
		bodyLines = append(bodyLines, m.renderHeaderRow(iw))
		bodyLines = append(bodyLines, TableHeaderSep(iw))

		if len(m.filtered) == 0 {
			bodyLines = append(bodyLines, MutedStyle.Render("no hosts match your filter"))
		} else {
			bodyLines = append(bodyLines, m.renderList(iw)...)
		}

		// Count line
		countStr := fmt.Sprintf("%d host", len(m.filtered))
		if len(m.filtered) != 1 {
			countStr = fmt.Sprintf("%d hosts", len(m.filtered))
		}
		bodyLines = append(bodyLines, "")
		bodyLines = append(bodyLines, DimStyle.Render(countStr))
	}

	body := strings.Join(bodyLines, "\n")
	panelWidth := m.width - 4
	if panelWidth < 56 {
		panelWidth = 56
	}
	return RoundedPanel(body, panelWidth)
}

// hostlistColumnWidths splits the inner width across the 6 columns. Env,
// User, Access are fixed; Customer, Server, Hostname split the rest.
func hostlistColumnWidths(iw int) (envW, custW, srvW, hostW, userW, accessW int) {
	envW = 8
	userW = 12
	accessW = 16
	const seps = 5 // 6 columns → 5 separators
	rest := iw - envW - userW - accessW - seps - 1
	if rest < 36 {
		rest = 36
	}
	custW = rest * 25 / 100
	if custW < 12 {
		custW = 12
	}
	srvW = rest * 35 / 100
	if srvW < 14 {
		srvW = 14
	}
	hostW = rest - custW - srvW
	if hostW < 12 {
		hostW = 12
	}
	return
}

func (m HostListModel) renderHeaderRow(iw int) string {
	envW, custW, srvW, hostW, userW, _ := hostlistColumnWidths(iw)
	env := TableHeaderStyle.Width(envW).Render("Env")
	cust := TableHeaderStyle.Width(custW).Render("Customer")
	server := TableHeaderStyle.Width(srvW).Render("Server")
	hostname := TableHeaderStyle.Width(hostW).Render("Hostname")
	user := TableHeaderStyle.Width(userW).Render("User")
	access := TableHeaderStyle.Render("Access")
	return env + " " + cust + " " + server + " " + hostname + " " + user + " " + access
}

func (m HostListModel) renderList(iw int) []string {
	var lines []string

	customerOrder, groups := groupByCustomer(m.filtered)
	visible := m.visibleRows()

	// Build flat index to map global cursor (host-only) to flat items.
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

	// Map filtered-host-index → flat-index.
	hostFlatIdx := map[int]int{}
	fi := 0
	hi := 0
	for _, item := range flat {
		if !item.isHeader {
			hostFlatIdx[hi] = fi
			hi++
		}
		fi++
	}

	// Compute first visible flat index from visibleStart.
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
			// Customer group subheader — dim, separating groups visually
			headerLine := DimStyle.Render("── " + item.customer + " ──")
			lines = append(lines, headerLine)
			rowsRendered++
			continue
		}

		selected := currentHostIdx == m.cursor
		lines = append(lines, m.renderHostRow(item.host, selected, iw))
		rowsRendered++
		currentHostIdx++
	}

	// Scroll indicator if needed.
	if len(m.filtered) > visible {
		scrollInfo := fmt.Sprintf("%d-%d of %d",
			m.visibleStart+1,
			min(m.visibleStart+visible, len(m.filtered)),
			len(m.filtered),
		)
		lines = append(lines, DimStyle.Render(scrollInfo))
	}

	return lines
}

func (m HostListModel) renderHostRow(h api.Host, selected bool, iw int) string {
	_, custW, srvW, hostW, userW, _ := hostlistColumnWidths(iw)

	// On selected rows, use uniform white text so the coral background fill
	// stays legible. Inner ANSI foreground colors would otherwise win and
	// some columns would render coral-on-coral (invisible).
	custFg := colorMuted
	srvFg := colorText
	hostFg := colorMuted
	userFg := colorMuted
	badge := EnvBadge(h.Environment)
	if selected {
		custFg = colorText
		srvFg = colorText
		hostFg = colorText
		userFg = colorText
		badge = EnvBadgePlain(h.Environment)
	}

	custCol := lipgloss.NewStyle().Width(custW).Foreground(lipgloss.Color(custFg)).Render(truncate(h.CustomerName, custW-1))

	name := h.Name
	if name == "" {
		name = h.Hostname
	}
	serverCol := lipgloss.NewStyle().Width(srvW).Foreground(lipgloss.Color(srvFg)).Render(truncate(name, srvW-1))

	hostnameCol := lipgloss.NewStyle().Width(hostW).Foreground(lipgloss.Color(hostFg)).Render(truncate(h.Hostname, hostW-1))

	userCol := lipgloss.NewStyle().Width(userW).Foreground(lipgloss.Color(userFg)).Render(truncate(h.Principal, userW-1))

	var accessStr string
	if selected {
		// Plain access label without per-status colors so the coral fill
		// can read uniformly.
		accessStr = h.AccessStatus
		if accessStr == "" {
			accessStr = "—"
		}
	} else {
		accessStr = AccessStatusStyle(h.AccessStatus)
	}
	if h.AccessExpiry != nil {
		d := h.AccessExpiry.Sub(nowFunc())
		if d > 0 {
			if selected {
				accessStr += " " + formatDuration(d)
			} else {
				accessStr += DimStyle.Render(" "+formatDuration(d))
			}
		}
	}

	content := badge + " " + custCol + " " + serverCol + " " + hostnameCol + " " + userCol + " " + accessStr

	if selected {
		return renderSelectedRow(content, iw)
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
