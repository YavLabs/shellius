# Task 13D: Smoke-Test Web Terminal Flow

**Agent:** qa
**Status:** [ ] Pending
**Blocks:** None
**Blocked By:** 13A, 13B

## Objective
Verify the access-request → terminal flow end-to-end against the running
production stack at https://shellius.yavlabs.com.

## Steps
1. Log in as `admin@yavlabs.com`.
2. Servers → row menu on a non-prod server → **Request Access**.
3. Confirm the create modal pre-fills the server.
4. Fill reason ≥ 10 chars, principal = an existing OS user, submit.
5. Click the new row in the AR list.
6. Detail modal:
   - All fields should be populated (no `-` for fields the API returned).
   - Status should be APPROVED (auto for non-prod when no policy requires
     approval) or PENDING.
7. If APPROVED, the credential block must show **Open Web Terminal**.
8. Click → routed to `/terminal?requestId=…`.
9. WebTerminal status indicator goes Connecting → Connected.
10. Type `hostname` → response shows the target host's hostname.

## Failure modes to watch
- Backend log: `ssh-keygen ENOENT` → openssh-keygen missing in image
- Backend log: `Authentication failed against database server` → postgres
  password drift between volume and `.env.prod`
- Frontend: blank fields in detail modal → service unwrap regression
- WebTerminal stuck on Connecting → ssh2 cert not being sent (Phase 12 fix)

## Reporting
Append a bullet list of pass/fail per step to this file under a `## Run`
heading. If a step fails, link to the file/line of the suspected fix.
