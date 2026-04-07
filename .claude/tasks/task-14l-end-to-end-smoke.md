# Task 14L: End-to-End Smoke Test (All Pages)

**Agent:** qa
**Status:** [x] Done
**Blocks:** None
**Blocked By:** 14D, 14E, 14F, 14G, 14H, 14I, 14J, 14K

## Objective
Click through every primary action on every page against the live stack
at https://shellius.yavlabs.com and record pass/fail. This is the gate
for closing Phase 14.

## Pages and actions to verify

### Dashboard
- [ ] Stat cards render real numbers
- [ ] Recent activity widget loads
- [ ] My Access widget loads

### Customers
- [ ] List loads
- [ ] Create customer
- [ ] Edit customer
- [ ] Delete customer
- [ ] Customer detail loads with stats and servers

### Servers
- [ ] List loads with all filters working
- [ ] Add server → bootstrap modal opens → copy command works
- [ ] Row menu: Request Access pre-fills server in AR form
- [ ] Row menu: Bootstrap Host opens modal
- [ ] Row menu: Health Check updates row status
- [ ] Row menu: Edit / Delete
- [ ] Bulk environment update

### Users
- [ ] Create + invite (Task 14G)
- [ ] Resend invite + password reset (Task 14G)
- [ ] Upload SSH key
- [ ] Deactivate / activate
- [ ] Delete

### Groups
- [ ] Create + delete
- [ ] Add / remove members

### Policies
- [ ] Create policy with default values (priority bug — Task 14E)
- [ ] Evaluator preview (Task 14E)
- [ ] Edit + delete

### Access Requests
- [ ] Create with valid Linux principal (Task 14F)
- [ ] Auto-approve for non-prod
- [ ] Manual approve / deny / revoke
- [ ] Detail modal renders all fields
- [ ] Open Web Terminal → real shell on the bootstrapped target

### Certificates
- [ ] List + filter
- [ ] Detail + download .pub (Task 14I)
- [ ] Expiry surfacing (Task 14I)
- [ ] Revoke

### Sessions
- [ ] List with filters (Task 14H)
- [ ] Detail with playback for recorded sessions (Task 14H)
- [ ] Terminate active session

### Audit Log
- [ ] Filters + search
- [ ] CSV / JSON export
- [ ] Expandable rows

### Settings
- [ ] Org tab: save name → persists across reload (Task 14A/14D)
- [ ] CA tab: rotate works
- [ ] SSO tab: save + test (Task 14B/14D)
- [ ] Notifications tab: persists (Task 14C/14D)
- [ ] Cloud tab: gone or implemented (Task 14K)

### Notifications
- [ ] /notifications page lists notifications (Task 14J)
- [ ] Mark all read clears bell

## Reporting
Append a `## Run YYYY-MM-DD` heading to this file with bullet pass/fail
per item. Link any failures to a follow-up bug task.
