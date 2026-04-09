# Shellius TUI Redesign Specification

> Concrete, executable design spec for the Shellius TUI. Implementation agent
> reads top to bottom and follows the rules verbatim. Where the spec is silent,
> prefer the simpler choice.

---

## 0. Current state (read first)

| File | Lines | Role today |
|---|---|---|
| `tui/internal/tui/app.go` | ~1034 | Root model, view enum, dispatcher, header/footer/help/profile/sessions overlays inline |
| `tui/internal/tui/styles.go` | ~218 | Color constants, badges, selection helpers |
| `tui/internal/tui/activeaccess.go` | ~474 | Home screen: list of approved access requests, filter, fetch+cache |
| `tui/internal/tui/hostlist.go` | ~393 | `/servers`: groupable browser, customer headers |
| `tui/internal/tui/accessrequest.go` | ~625 | Multi-state form: intent → form → submitting → polling → approved/denied/web/error |
| `tui/internal/tui/myrequests.go` | ~248 | Read-only history list with status glyphs |
| `tui/internal/tui/palette.go` | ~284 | `/` overlay, fuzzy filter, command registry |
| `tui/internal/tui/login.go` | ~302 | URL prompt + device-auth login |
| `tui/internal/tui/statusbar.go` | ~94 | Currently unused/legacy helpers |

What each screen accepts and routes to today is captured in section H.

---

## A. Design principles

1. **No outer chrome on full screens.** No box, no border, no horizontal rules around content areas. Borders exist only for the palette overlay and for the device-code block on the login screen. Everything else is naked text against the alt-screen background.
2. **Two-space left margin, full-bleed right.** Every line of content starts at column 2. There is no right padding or right gutter — content runs to the edge. This is the Claude Code / lazygit body convention.
3. **One accent color, used sparingly.** `#d97757` (warm coral) appears only in three places: the selection marker (`▎`), the focused form-field label, and the wordmark in the header. Nowhere else. Status uses semantic colors; everything else is mono.
4. **Header is one line. Footer is one line. Both are dim.** The header is `shellius · user@org · server-url`. The footer is contextual key hints. Neither is bold. Neither has a separator rule above or below it.
5. **Selection is a left marker, never a background fill.** Selected rows get `▎ ` in the accent color and bold text. Non-selected rows get two leading spaces.
6. **Status is a single glyph with semantic color, not a boxed pill.** `●` approved, `○` pending, `✗` denied, `·` expired, `⊘` revoked. Environment is rendered as the lowercase word in its color, width 8, never uppercase, never boxed.
7. **Empty / loading / error are first-class.** Every screen has an explicit empty, loading, and error render path. Loading is `spinner + "loading X..."`. Empty is one dim line that names the next action. Error is `error: <msg>` with a one-line retry hint.

---

## B. Color palette

Eight named colors. Implementation: rename in `styles.go` so this is the canonical list. Drop legacy aliases.

| Name | Hex | Usage |
|---|---|---|
| `colorAccent` | `#d97757` | Selection marker `▎`, focused field label, wordmark "shellius", login user-code, request-ID code blocks. **Nowhere else.** |
| `colorText` | `#e6e6e6` | Default body text, primary list-item names, bold titles |
| `colorMuted` | `#8a8a8a` | Secondary metadata: principal, customer name, "expires in...", footer hints |
| `colorDim` | `#5a5a5a` | Tertiary: customer group headers, count parens `(3)`, scroll indicator, separator dots, footer keybinding glyphs |
| `colorOK` | `#7eb87e` | Approved status glyph, "live" session, success state |
| `colorWarn` | `#d4b85a` | Pending status glyph, stale-cache hint, toast |
| `colorErr` | `#cf6a6a` | Denied/error status glyph, validation errors, error screen title |
| `colorBorder` | `#2a2a2a` | The palette overlay border. **Only place a border is drawn.** |

Environment colors collapse from four to three reusable semantic ones (the env tag is just text in its color, not its own palette):

- `prod` → `colorErr`
- `staging` → `colorWarn`
- `dev` → `#6e9aa6` (cool slate — the one extra hue allowed because dev/staging/prod must be distinguishable at a glance)
- `demo` → `colorDim`

That's it. No `colorHighlight`, no `colorSurface`, no `colorBg`, no `colorSeparator`, no `colorEnvDev/Staging/Prod/Demo` aliases. Delete them.

---

## C. Typography hierarchy

| Weight | When to use |
|---|---|
| **Bold + colorText** | Section title (e.g. "Active Access"), selected row content, primary CTAs (`Login successful`), the wordmark in the header |
| Regular + colorText | Default body, host name in a list row, form field values |
| Regular + colorMuted | Metadata: principal, customer, "expires in 2h", "Connecting to..." |
| Regular + colorDim | Customer group headers, count parens, scroll info, footer hints |
| Bold + colorAccent | The wordmark "shellius", focused field label, "Reason" when active |
| Regular + colorErr (bold for "Error" word only) | Inline validation errors, error screen titles |

No italics. No underlines. No background fills (except the device-code highlight on login, which is preserved).

Reference: this is exactly how lazygit/k9s render — bold for "current item", muted for everything else, single accent for the active indicator.

---

## D. Layout primitives

### Header (one line, top of every authenticated screen)

```
  shellius · alice@acme · https://shellius.acme.com
```

- Two-space left margin.
- `shellius` is bold + accent.
- ` · ` separators are dim.
- User identity and server URL are dim regular.
- No trailing content. No tab bar. No status indicators on the right.
- Followed by **one** blank line, then the screen content.

### Footer (one line, bottom of every authenticated screen)

```
  ↑↓ select  enter connect  / commands  ? help  q quit
```

- Two-space left margin.
- All dim. No bold.
- Two spaces between groups, not the bullet character.
- Always present. Contextual to the current view.

### Selection marker

`▎ ` (U+258E + space) in `colorAccent`. Selected row content is bold. Non-selected rows are prefixed with two spaces so columns align.

### Status badges

One glyph, colored, no padding:

- `●` `colorOK` — APPROVED, live
- `○` `colorWarn` — PENDING
- `✗` `colorErr` — DENIED
- `·` `colorDim` — EXPIRED
- `⊘` `colorDim` — REVOKED

### Environment label

Lowercase, width 8, foreground = env color. No box, no caps, no brackets.

```
prod      staging   dev       demo
```

### Spinner placement

Inline at column 2, immediately followed by one space and the loading message:

```
  ⠋ loading active access...
```

Never on its own line. Never centered.

### Empty state

One dim line at column 2 that names the next action:

```
  no active access — press / and choose /request
```

### Error state (in-screen, recoverable)

```
  error: connection refused
  r retry  ·  esc back
```

`error:` is bold `colorErr`, message is muted, hint is dim.

### Error state (full screen, see section E10 for the wrapping case)

---

## E. Per-screen ASCII mockups

All mockups are 80 cols × 24 rows. The literal `·` is U+00B7. The `▎` is U+258E.

### E1. Login — server URL prompt

```
                                                                                
  shellius                                                                      
  centralized ssh/rdp access management                                         
                                                                                
  Shellius server URL                                                           
  > https://shellius.acme.com_                                                  
                                                                                
  enter continue  ·  ctrl+c quit                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
```

Pre-login screens have **no header bar** (no creds yet) and **no footer** beyond the inline hint. Wordmark lives in the body.

Pattern source: glow's first-run flow. Keys: `enter` submit, `ctrl+c` quit.

### E1b. Login — device flow waiting

```
                                                                                
  shellius                                                                      
  centralized ssh/rdp access management                                         
                                                                                
  Sign in at:                                                                   
                                                                                
  https://shellius.acme.com/device                                              
                                                                                
  Your code:   WXYZ-1234                                                        
                                                                                
  ⠋  Waiting for browser approval...                                            
                                                                                
  browser opened automatically  ·  ctrl+c cancel                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
```

The user code keeps its current background highlight box (it's the only background fill in the whole TUI, and it earns its place — this is the value the user has to type). URL is in `colorAccent`.

### E2. Active Access (home) — populated

```
  shellius · alice@acme · https://shellius.acme.com                             
                                                                                
  Active Access (4)                                                             
  filter...                                                                     
                                                                                
  ▎ prod      api-gateway-01           ubuntu        expires in 1h47m           
    staging   web-frontend-02          deploy        expires in 23m             
    dev       analytics-worker-3       ubuntu        expires in 5h12m           
    prod      payments-db-primary      postgres      expires in 38m             
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
  ↑↓ select  enter connect  / commands  ? help  q quit                          
```

- Section title bold, count `(4)` dim.
- Filter input on its own line, no border, placeholder italicless dim.
- Columns: env (8) + name (24) + principal (12) + expiry (rest).
- Selected row: accent `▎` + bold name. Other rows: 4 leading spaces (2 margin + 2 marker pad), no bold.
- No "cached" / "stale" inline tag — see section G.

Pattern source: lazygit branches pane + gh dash issue list. Keys on this view: `↑/k` `↓/j` `enter` `/` `?` `q` `r`.

### E2b. Active Access — empty

```
  shellius · alice@acme · https://shellius.acme.com                             
                                                                                
  Active Access (0)                                                             
  filter...                                                                     
                                                                                
  no active access — press / and choose /request                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
  ↑↓ select  enter connect  / commands  ? help  q quit                          
```

### E2c. Active Access — loading

```
  shellius · alice@acme · https://shellius.acme.com                             
                                                                                
  ⠋ loading active access...                                                    
                                                                                
                                                                                
... (blank to row 23) ...                                                       
  ↑↓ select  enter connect  / commands  ? help  q quit                          
```

### E3. Hosts (`/servers`) — populated, grouped by customer

```
  shellius · alice@acme · https://shellius.acme.com                             
                                                                                
  Hosts (12)                                                                    
  filter hosts...                                                               
                                                                                
  acme-corp                                                                     
  ▎ prod      api-gateway-01           needs approval                           
    prod      payments-db-primary      approved      expires 38m                
    staging   web-frontend-02          approved      expires 23m                
    dev       analytics-worker-3       approved      expires 5h12m              
                                                                                
  beta-inc                                                                      
    prod      bastion-eu-west-1        needs approval                           
    staging   ci-runner-02             ready                                    
    demo      sandbox-shared           ready                                    
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
  ↑↓ select  enter request  esc back  r refresh  / commands                     
```

- Customer group header is dim, no `▼` glyph, no underline.
- Same row format as E2 but with access-status text instead of expiry-only.
- Keys: `↑/k`, `↓/j`, `enter`, `esc`, `r`, `/`, `?`.

Pattern source: gh dash sectioned list, k9s namespace switcher.

### E4. New Access Request form

```
  shellius · alice@acme · https://shellius.acme.com                             
                                                                                
  Request access                                                                
  prod  api-gateway-01  acme-corp                                               
                                                                                
  Protocol                                                                      
  ● SSH    ○ RDP                                                                
                                                                                
  Reason                                                                        
  > Investigating elevated 5xx rate after this morning's deploy_                 
                                                                                
  Duration                                                                      
  > 2    hours    ←→ change unit                                                
                                                                                
  Principal                                                                     
  > ubuntu                                                                      
                                                                                
                                                                                
                                                                                
                                                                                
  tab next  enter submit  esc cancel  ←→ cycle  p toggle protocol               
```

- Title `Request access` bold.
- Host summary line: env tag + bold name + muted customer.
- One blank between fields. Field label on its own line, dim normally, **accent + bold** when focused (no `>` indicator on the label — the focus is shown by color and the textinput's own cursor).
- The `>` is the textinput's prompt.
- Selected radio is `●` accent bold, unselected `○` muted.
- Validation error appears on its own line below the offending field in `colorErr`, prefixed with `! `. It does not push the layout — there's enough headroom in the 24-row budget.

Keys: `tab`/`shift+tab`, `↑/↓` (alt to tab), `enter` (next field, or submit on last field), `←/→` cycle unit/principal/protocol, `esc` cancel, `p` toggle protocol.

Pattern source: bubbletea `examples/textinputs`.

### E4b. Form with validation error

```
  shellius · alice@acme · https://shellius.acme.com                             
                                                                                
  Request access                                                                
  prod  api-gateway-01  acme-corp                                               
                                                                                
  Protocol                                                                      
  ● SSH    ○ RDP                                                                
                                                                                
  Reason                                                                        
  > too short_                                                                  
  ! reason must be at least 10 characters (currently 9)                         
                                                                                
  Duration                                                                      
  > 2    hours    ←→ change unit                                                
                                                                                
  Principal                                                                     
  > ubuntu                                                                      
                                                                                
                                                                                
                                                                                
  tab next  enter submit  esc cancel  ←→ cycle  p toggle protocol               
```

### E5. Waiting for approval

```
  shellius · alice@acme · https://shellius.acme.com                             
                                                                                
  Request access                                                                
  prod  api-gateway-01  acme-corp                                               
                                                                                
  ⠋ Waiting for approval...                                                     
                                                                                
  Request   ar_01HX8Z3KQNFBR2A7TJ5VWMP                                          
  Status    ○ pending                                                           
  Reason    Investigating elevated 5xx rate after this morning's deploy         
  Duration  2 hours                                                             
                                                                                
  Your manager has been notified. Polling every 3s.                             
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
  esc cancel and go back                                                        
```

- Spinner inline with the polling message, accent color.
- Request ID in `colorAccent` (it's a thing the user might need to copy).
- Status glyph + lowercased word.
- Below, denied state replaces this body with:

### E5b. Denied

```
  shellius · alice@acme · https://shellius.acme.com                             
                                                                                
  Request access                                                                
  prod  api-gateway-01  acme-corp                                               
                                                                                
  ✗ Access denied                                                               
                                                                                
  Reason    No change ticket on file. Open one and resubmit.                    
  Manager   bob@acme                                                            
  At        14:32                                                               
                                                                                
  esc back                                                                      
                                                                                
... (blank) ...                                                                 
                                                                                
  esc back                                                                      
```

- `✗ Access denied` bold + `colorErr`.
- Reason wraps if long (see E10 wrapping rules — same logic).

### E6. My Requests history

```
  shellius · alice@acme · https://shellius.acme.com                             
                                                                                
  My Access Requests (18)                                                       
                                                                                
  ▎ ● prod      api-gateway-01           ubuntu     expires 1h47m               
    ● staging   web-frontend-02          deploy     expires 23m                 
    ○ prod      bastion-eu-west-1        ubuntu     12m ago                     
    ✗ prod      payments-db-replica      postgres   04-07 11:22                 
    · dev       analytics-worker-3       ubuntu     04-06 18:51                 
    · staging   ci-runner-02             builder    04-05 09:14                 
    ⊘ prod      legacy-mailgw            root       04-04 22:08                 
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
  ↑↓ select  r refresh  esc back                                                
```

Pattern source: gh dash, glow's bookmark list. Keys: `↑/↓`, `r`, `esc`, `q`.

### E7. Command palette overlay

```
  shellius · alice@acme · https://shellius.acme.com                             
                                                                                
  ╭────────────────────────────────────────────────────────────────────╮        
  │ / serv_                                                            │        
  │                                                                    │        
  │ ▎ /servers      Browse all servers                                 │        
  │   /sessions    Active and recent sessions                          │        
  │   /refresh     Refresh the active access list                      │        
  │                                                                    │        
  │ esc cancel  ↑↓ select  enter run                                   │        
  ╰────────────────────────────────────────────────────────────────────╯        
                                                                                
  Active Access (4)                                                             
  filter...                                                                     
                                                                                
  ▎ prod      api-gateway-01           ubuntu        expires in 1h47m           
    staging   web-frontend-02          deploy        expires in 23m             
    dev       analytics-worker-3       ubuntu        expires in 5h12m           
                                                                                
  ↑↓ select  enter connect  / commands  ? help  q quit                          
```

- The palette is the **only** screen element with a border. Rounded corners, `colorBorder`.
- The underlying screen stays visible underneath (not blanked).
- Command names in `colorAccent`, descriptions in `colorMuted`.
- Selected row uses the same `▎` marker as everywhere else.
- Width is `min(70, terminal-6)`.

Keys (palette active): `↑/↓` move, `enter` run, `esc` close, any printable adds to the filter, `backspace` deletes.

Pattern source: lazygit command menu, k9s `:` palette.

### E8. Help / keybindings

```
  shellius · alice@acme · https://shellius.acme.com                             
                                                                                
  Key bindings                                                                  
                                                                                
  Navigation                                                                    
    ↑ k          move up                                                        
    ↓ j          move down                                                      
    g            top of list                                                    
    G            bottom of list                                                 
    enter        connect / submit / open                                        
    esc          back                                                           
                                                                                
  Global                                                                        
    /            command palette                                                
    ?            this help                                                      
    r            refresh current view                                           
    ctrl+c       quit                                                           
                                                                                
  Commands                                                                      
    /servers     /request    /myrequests    /sessions                           
    /profile     /refresh    /logout        /quit                               
                                                                                
  esc close                                                                     
```

Section labels are bold `colorText`. Keys are `colorAccent`. Descriptions are muted. Width 14 column for the key, rest is description.

### E9. Profile overlay

```
  shellius · alice@acme · https://shellius.acme.com                             
                                                                                
  Profile                                                                       
                                                                                
  User             alice                                                        
  Org              acme                                                         
  Role             operator                                                     
  Server URL       https://shellius.acme.com                                    
  Token expires    47m from now                                                 
  Config path      /home/alice/.shellius/config.yaml                            
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
  esc close                                                                     
```

Labels left-padded width 16, muted. Values plain text.

### E10. Error view (long, wrapping SSH cert dump)

```
  shellius · alice@acme · https://shellius.acme.com                             
                                                                                
  SSH connection failed                                                         
                                                                                
  exit status 255                                                               
                                                                                
  Permission denied (publickey).                                                
                                                                                
  cert                                                                          
    Type: ssh-ed25519-cert-v01@openssh.com user certificate                     
    Public key: ED25519-CERT SHA256:abc123...                                   
    Signing CA: ED25519 SHA256:def456... (using ssh-ed25519)                    
    Key ID: "alice@acme:ar_01HX8Z3KQNFBR2A7TJ5VWMP"                             
    Valid: from 2026-04-08T14:30:00 to 2026-04-08T16:30:00                      
    Principals: ubuntu                                                          
                                                                                
  hint                                                                          
    Cert principals do not match the requested user. Check that                 
    your access request principal matches the SSH user on the                   
    target host.                                                                
                                                                                
  esc back  ·  /sessions to retry                                               
```

Wrapping rules for the error screen:
- The body is hard-wrapped to `terminal_width - 4` columns.
- Rendered as plaintext, no syntax highlighting, no boxes.
- Section labels (`cert`, `hint`) are dim, two-space indented body lines under them.
- The screen scrolls vertically if the error is taller than the viewport — use `j/k` and `g/G`. (This is new — currently the error view does not scroll. The implementation agent should add a `viewport.Model` from bubbles for this.)
- The error title `SSH connection failed` is bold `colorErr`. The bare `exit status 255` is muted.

Pattern source: glow's viewport scroll for long markdown.

---

## F. Keybinding map

| Key | Active Access | Hosts | Form | Polling | My Requests | Help/Profile/Sessions | Palette | Error |
|---|---|---|---|---|---|---|---|---|
| `↑` `k` | move up | move up | prev field | — | move up | — | move up | scroll up |
| `↓` `j` | move down | move down | next field | — | move down | — | move down | scroll down |
| `g` | top | top | — | — | top | — | — | top |
| `G` | bottom | bottom | — | — | bottom | — | — | bottom |
| `←` `→` | — | — | cycle unit / principal / protocol | — | — | — | — | — |
| `tab` | — | — | next field | — | — | — | — | — |
| `shift+tab` | — | — | prev field | — | — | — | — | — |
| `enter` | connect | open form | next field / submit | — | — | close | run | back |
| `esc` | — | back | cancel | cancel | back | close | close | back |
| `q` | quit | back | — | — | back | close | — | back |
| `/` | open palette | open palette | — | — | open palette | — | — | — |
| `?` | help | help | — | — | help | — | — | — |
| `r` `ctrl+r` | refresh | refresh | — | — | refresh | — | — | — |
| `p` | — | — | toggle protocol | — | — | — | — | — |
| `ctrl+c` | quit | quit | quit | quit | quit | quit | quit | quit |
| printable | filter | filter | input | — | — | — | filter | — |

The `g`/`G` bindings are new — add them to all list views. The `←/→` bindings on the form are unchanged.

---

## G. What to delete

1. **The "cached" / "stale" inline hint.** Remove the `cacheHint` field, `activeAccessCacheHintExpired`, `scheduleCacheHintExpiry`, and the inline render in `activeaccess.go`. If a background refresh fails the user gets a one-line toast above the header (which already exists). The list itself stays clean.
2. **The `[stale: <truncated error>]` warn-color tag.** Same removal as above.
3. **`StatusBarStyle`, `BorderStyle` (when applied to full screens), `HighlightStyle` (except in login.go for the user code), `colorBg`, `colorSurface`, `colorSeparator`, `colorHighlight` (except for login user code), all `colorEnv*` aliases.** Collapse to the eight palette entries in section B.
4. **`SeparatorStyle` and the `─` rule under the form host summary.** Replace with one blank line.
5. **`statusbar.go`** — currently 94 lines of legacy helpers, none referenced by the new chrome. Delete.
6. **The `viewSessions` overlay's two-section "Active / Recent" bold headers and indented bullets.** Replace with the same flat list pattern as `myrequests`. The `live` / `done` labels become the same `●` / `·` glyphs as elsewhere.
7. **`ToastStyle.Render("› " + ...)`** — keep the toast logic but drop the `›` prefix. One muted line, no decoration.
8. **The `connectFromAR` `serverDisplayName` two-codepath** — out of scope, leave alone (it's wired into preserved logic).
9. **`PaletteItemSelected` and `PaletteItemNormal` styles** in styles.go — replaced by the shared `renderSelectedRow` / `renderNormalRow` so the palette uses the same marker as the lists. (Already partially done in palette.go; finish by removing the now-unused styles.)
10. **The "Shellius — Centralized SSH/RDP Access Management" double subtitle on the login page.** Use only the wordmark, lowercase, with a single dim subtitle line.
11. **The `Width(8)` env-badge column padding when env is empty.** If env is empty, render eight spaces instead of `unknown` — `unknown` is louder than the data.
12. **`renderHelp` / `renderProfile` / `renderSessions` inline in `app.go`.** Extract each to its own file (`help.go`, `profile.go`, `sessions.go`) so `app.go` shrinks back below ~500 lines.
13. **The `viewConnecting` enum value and its `"Connecting..."` render.** It is no longer reachable — connection happens via `tea.ExecProcess` directly from the active-access view.

---

## H. What MUST be preserved (CRITICAL CHECKLIST)

Implementation agent: tick each one off before declaring done. File:line refs are from the current main branch.

| # | Behavior | File | Line(s) |
|---|---|---|---|
| H1 | `shellius login <url>` subcommand: sets URL, wipes tokens, falls into device flow | `tui/cmd/shellius/main.go` | 85–105 |
| H2 | Top-level `Update()` handling of `sshConnectMsg` | `tui/internal/tui/app.go` | 234–235 |
| H3 | Top-level `Update()` handling of `sshExitedMsg` (routes back to active-access on session end) | `tui/internal/tui/app.go` | 236–246 |
| H4 | Top-level `appErrMsg` handling with `errors.Is(err, api.ErrSessionExpired)` → wipe creds → route to login | `tui/internal/tui/app.go` | 247–264 |
| H5 | Top-level `openWebTerminalMsg` handling | `tui/internal/tui/app.go` | 270–272 |
| H6 | `connectFromAR` policy-disabled fallback → `StartWebTerminal` → `openWebTerminalMsg` | `tui/internal/tui/app.go` | 504–534 |
| H7 | `openWebTerminal` → `open`/`xdg-open`/`rundll32` per OS | `tui/internal/tui/app.go` | 480–499 |
| H8 | `execSSH` ssh stderr capture via bounded buffer | `tui/internal/tui/app.go` | 614–615, 712–729 |
| H9 | `execSSH` `inspectCert` and `diagnoseSSH` on failure | `tui/internal/tui/app.go` | 631–654, 675–708 |
| H10 | `execSSH` preference for `creds.Address` over `creds.Hostname` (the IP-vs-DNS fix) | `tui/internal/tui/app.go` | 568–582 |
| H11 | Exit-1 from ssh treated as normal session end (not error) | `tui/internal/tui/app.go` | 622–630 |
| H12 | `WriteTempCreds` writing `<keyPath>-cert.pub` next to the key (filename `id` and `id-cert.pub`) | `tui/internal/ssh/config.go` | 23, 33 |
| H13 | `api.Client.ErrSessionExpired` re-export | `tui/internal/api/client.go` | 23–26 |
| H14 | `api.HTTPError` type with `Status` field | `tui/internal/api/client.go` | 28–37 |
| H15 | `api.Client.GetAccessIntent` | `tui/internal/api/client.go` | 387–389 |
| H16 | `api.Client.ListMyAccessRequests` | `tui/internal/api/client.go` | 333–335 |
| H17 | `api.Client.StartWebTerminal` | `tui/internal/api/client.go` | 420–423 |
| H18 | `api.SshCreds.Address` field | `tui/internal/api/client.go` | 103 |
| H19 | `auth.ErrSessionExpired` sentinel returned on HTTP 401 from refresh | `tui/internal/auth/token.go` | 15–19, 79 |
| H20 | `ssh.BuildCommand` arguments — no `LogLevel=ERROR`, includes `ConnectTimeout=10` and `CertificateFile=` | `tui/internal/ssh/connect.go` | 43–64 |
| H21 | Active Access `tea.KeyMsg` fall-through guard (don't let unrecognized keys reach the textinput) | `tui/internal/tui/activeaccess.go` | 264–276 |
| H22 | Hostlist `tea.KeyMsg` fall-through guard (same fix) | `tui/internal/tui/hostlist.go` | 144–154 |
| H23 | Palette `▎ ` `SelectionMarker` rendered with accent color (the cursor visibility fix) | `tui/internal/tui/palette.go` | 268–275 |
| H24 | `isKeyDownloadDisabled` HTTP 403 detection | `tui/internal/tui/accessrequest.go` | 613–624 |
| H25 | Form auto-skip when intent says `HasActiveAccess` (jump straight to `arApprovedMsg`) | `tui/internal/tui/accessrequest.go` | 196–200 |
| H26 | Form auto-poll when intent says `HasPendingRequest` | `tui/internal/tui/accessrequest.go` | 203–207 |
| H27 | Linux principal regex validation | `tui/internal/tui/accessrequest.go` | 21, 389–394 |
| H28 | Sessions state register/close around `tea.ExecProcess` | `tui/internal/tui/app.go` | 591–605, 620–663 |

If any of H1–H28 stops working after the redesign, the redesign is incomplete. They are functional contracts, not visual ones — the visual layer can be replaced freely as long as these messages, fields, and transitions still flow.

---

## I. Implementation order

Do the work in this order. Each step compiles and runs cleanly before moving to the next.

1. **`styles.go` rewrite.** Collapse the palette to the eight constants in section B. Delete legacy aliases. Keep `EnvBadge`, `StatusBadge`, `AccessStatusStyle`, `SelectionMarker`, `renderSelectedRow`, `renderNormalRow`. Add a new `renderHeader(cfg)` and `renderFooter(hints string)` helper here so they're reusable.
2. **Extract chrome.** Move `renderHeader` and `renderFooter` out of `app.go` into `styles.go` (or a new `chrome.go`). Have `app.go` call them. This is a pure refactor — visuals unchanged. Verify all H items still work.
3. **Delete dead code.** Remove `statusbar.go`. Delete `viewConnecting`, `cacheHint`, `scheduleCacheHintExpiry`, `activeAccessCacheHintExpired`, the unused styles listed in section G item 3 and 9. Compile.
4. **Rewrite `activeaccess.go` View().** Implement E2 / E2b / E2c. Verify H21.
5. **Rewrite `hostlist.go` View() / `renderList`.** Implement E3. Verify H22.
6. **Rewrite `accessrequest.go` View() / `renderForm`.** Implement E4 / E4b / E5 / E5b. Verify H24/H25/H26/H27.
7. **Rewrite `myrequests.go` View().** Implement E6.
8. **Rewrite `palette.go` View().** Implement E7. Verify H23.
9. **Extract overlays.** Create `help.go`, `profile.go`, `sessions.go` from the inline `app.go` renderers. Implement E8 / E9 / sessions-as-list.
10. **Error view scroll.** Add `bubbles/viewport` for long error wrap (E10). Verify H8/H9 capture path still feeds it.
11. **Login rewrite.** Implement E1 / E1b. Pre-login screens: no header, no footer, just the body. Preserve H19.
12. **Add new keybindings.** `g` and `G` on every list. Wire through Update functions.
13. **Manual smoke test the H checklist.** `shellius login <url>`, login flow, active access, /servers, form for prod, polling, approval, ssh, exit, web terminal fallback, session expiry. All 28 H items must still work.

---

## Notes for the implementation agent

- Where this spec is silent on a color, use `colorMuted`.
- Where this spec is silent on whether a thing should be bold, it should not.
- Where this spec is silent on a key, the view should ignore it (no fall-through into a textinput).
- Do not introduce new third-party dependencies beyond `bubbles/viewport`.
- Do not change message types, field names, or function signatures listed in section H.
- The 80×24 budget in section E is the lower bound; the layout must remain coherent at 120×40 too. The header and footer stay one line each; the content area grows.
- Two-space left margin is everywhere. There is no exception.
