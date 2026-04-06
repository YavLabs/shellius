# Task 2D: Authentication and User/Group Management Frontend

**Agent:** frontend
**Status:** [ ] Pending
**Blocks:** none
**Blocked By:** 2A

## Objective
Implement the login flow with JWT handling, complete the AuthContext with real API integration, and build the Users and Groups management pages with full CRUD UI.

## Deliverables

### Login Page
- `/frontend/src/pages/Login.jsx` — full implementation: email + password form, error display, loading state, redirect to /dashboard on success. Clean centered card design with Shellius branding. Optional "SSO Login" button that redirects to /api/auth/sso/:orgSlug.

### AuthContext (complete implementation)
- `/frontend/src/contexts/AuthContext.jsx`:
  - `login(email, password)` — call POST /api/auth/login, store tokens in memory (access) and httpOnly cookie or secure localStorage (refresh), set user state
  - `logout()` — call POST /api/auth/logout, clear tokens and user state, redirect to /login
  - `refresh()` — call POST /api/auth/refresh, update access token silently
  - Auto-refresh: set up interval to refresh access token before expiry
  - `user`, `isAuthenticated`, `isLoading` state values exposed via context

### Users Page
- `/frontend/src/pages/Users.jsx`:
  - Data table with columns: Name, Email, Role (badge), Status (badge), Manager, Last Login
  - Manager column shows manager name with link to that user's detail
  - Search/filter bar: text search, role dropdown, status dropdown
  - "Add User" button opening a modal/drawer form
  - Row actions: Edit, Upload SSH Key, Deactivate, Delete (with confirmation dialog)
  - Pagination controls

### User Form
- `/frontend/src/components/users/UserForm.jsx` — shared create/edit form: first_name, last_name, email, role select, status select, manager_id searchable select (filtered to same org users)
- `/frontend/src/components/users/SshKeyDialog.jsx` — textarea for pasting SSH public key, validation feedback, current key display with copy button

### Groups Page
- `/frontend/src/pages/Groups.jsx`:
  - Card grid or table: group name, description, member count
  - "Create Group" button with modal form
  - Click-through to group detail

### Group Detail
- `/frontend/src/pages/GroupDetail.jsx`:
  - Group info header with edit/delete actions
  - Members list with avatar, name, email, role badge
  - "Add Member" button with user search/select dropdown
  - Remove member button on each row with confirmation

### Shared Components
- `/frontend/src/components/shared/DataTable.jsx` — reusable table with sorting, pagination props
- `/frontend/src/components/shared/ConfirmDialog.jsx` — reusable confirmation modal
- `/frontend/src/components/shared/SearchInput.jsx` — debounced search input with Lucide Search icon

## Acceptance Criteria
- Login with valid credentials stores tokens and redirects to dashboard
- Login with invalid credentials shows error message without exposing which field was wrong
- Access token auto-refreshes before expiry without interrupting user flow
- Expired refresh token redirects to login page with a "Session expired" message
- Users table loads with pagination, shows all columns correctly
- Manager hierarchy is visible: clicking a manager name navigates to that user
- SSH key upload validates format client-side before submitting
- Group CRUD works end-to-end: create, rename, delete with member management
- All forms show loading spinners during submission and disable the submit button
- Toast notifications appear for success/error on all mutations
- All components use plain JavaScript, Lucide icons, shadcn/ui primitives
