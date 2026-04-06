# Task 1D: React/Vite Frontend Shell

**Agent:** frontend
**Status:** [ ] Pending
**Blocks:** none
**Blocked By:** 1A

## Objective
Initialize the React frontend with Vite, configure Tailwind CSS and shadcn/ui components, build the application layout shell, and set up auth/theme context stubs. This provides the visual skeleton and routing infrastructure for all subsequent frontend tasks.

## Deliverables

### Vite + Tailwind Setup
- `/frontend/vite.config.js` — Vite config with React plugin, proxy /api to backend:3001, path aliases (@/ for src/)
- `/frontend/tailwind.config.js` — Tailwind config with shadcn/ui preset, custom colors (slate/zinc palette), dark mode class strategy
- `/frontend/postcss.config.js` — PostCSS with Tailwind and autoprefixer
- `/frontend/src/index.css` — Tailwind directives, CSS variables for shadcn/ui theming, base typography

### shadcn/ui Components
- `/frontend/components.json` — shadcn/ui config pointing to src/components/ui
- Install initial components: Button, Input, Card, Badge, Avatar, DropdownMenu, Sheet, Separator, Tooltip

### Layout Shell
- `/frontend/src/components/layout/Sidebar.jsx` — collapsible sidebar with nav links (Dashboard, Users, Groups, Customers, Servers, Connectors), org name at top, user avatar at bottom, Lucide icons for each item
- `/frontend/src/components/layout/Topbar.jsx` — breadcrumb trail, theme toggle button, notification bell placeholder, user dropdown (profile, logout)
- `/frontend/src/components/layout/AppLayout.jsx` — flex layout combining Sidebar + Topbar + main content area with Outlet

### Contexts
- `/frontend/src/contexts/AuthContext.jsx` — createContext + provider: user state, login/logout/refresh stubs, isAuthenticated derived boolean, loading state
- `/frontend/src/contexts/ThemeContext.jsx` — dark/light/system theme, persists to localStorage, applies class to document root

### Services
- `/frontend/src/services/api.js` — Axios instance with baseURL from env, request interceptor attaching Bearer token, response interceptor handling 401 (trigger refresh or redirect to login)

### Routing
- `/frontend/src/App.jsx` — BrowserRouter with routes: /login (public), / (protected, AppLayout wrapper), /dashboard, /users, /groups, /customers, /servers, /connectors
- `/frontend/src/components/ProtectedRoute.jsx` — checks AuthContext, redirects to /login if unauthenticated

### Page Stubs
- `/frontend/src/pages/Login.jsx` — centered card with email/password inputs and submit button, calls AuthContext.login
- `/frontend/src/pages/Dashboard.jsx` — placeholder with welcome message and empty stat cards

## Acceptance Criteria
- `npm run dev` starts Vite dev server and renders the login page at /login
- Sidebar navigation links route to correct stub pages without full page reload
- Dark mode toggle switches theme and persists across page refresh
- Sidebar collapses to icon-only mode on toggle or at mobile breakpoints
- API service automatically attaches auth token from context to outgoing requests
- Protected routes redirect to /login when no auth token exists
- Tailwind classes and shadcn/ui components render correctly (no unstyled flashes)
- All components use plain JavaScript (no TypeScript)
