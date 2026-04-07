# Task 15F: Favicon + Page Title

**Agent:** frontend
**Status:** [x] Done
**Blocks:** 15Q-F
**Blocked By:** None
**Model:** sonnet (default) — but this is small enough for haiku if scheduling matters

## Objective
The browser tab is blank. Add a favicon, the Shellius logomark, and a
page-aware document title.

## Deliverables
- `frontend/public/favicon.ico` — multi-resolution ICO (16/32/48)
- `frontend/public/favicon-32x32.png` — fallback PNG
- `frontend/public/apple-touch-icon.png` — 180×180 for iOS
- Edit `frontend/index.html` `<head>`:
  ```html
  <link rel="icon" type="image/x-icon" href="/favicon.ico" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
  <link rel="manifest" href="/site.webmanifest" />
  <title>Shellius — SSH/RDP Access</title>
  <meta name="theme-color" content="#0a0a0a" />
  ```
- `frontend/public/site.webmanifest` with name, short_name, theme_color, icons.
- New hook `frontend/src/hooks/useDocumentTitle.js` that takes a page
  title string and sets `document.title = '<page> — Shellius'`. Mount
  it in each top-level page component (or once in `AppLayout` reading
  the route from `useLocation`).

## Asset source
The Lucide `Terminal` icon is what the sidebar uses today — recreate
it as a 32×32 monochrome PNG on a dark background, export to ICO via
ImageMagick:
```bash
convert -background "#0a0a0a" -fill "#ffffff" \
  -font /path/to/font.ttf -gravity center -size 32x32 \
  label:">_" /tmp/shellius-32.png
convert /tmp/shellius-32.png -define icon:auto-resize=16,32,48 frontend/public/favicon.ico
```
Or: hand-author a tiny inline SVG and use that as the favicon
directly via `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />`
which is the simplest path and avoids ImageMagick entirely.

## Acceptance
- New tab on https://shellius.yavlabs.com shows a Shellius favicon in
  Chrome, Firefox, Safari, and Edge.
- Tab title reads `Servers — Shellius` / `Settings — Shellius` etc.
- Bookmarking the page picks up the icon.
- Lighthouse PWA "favicon" check passes.
