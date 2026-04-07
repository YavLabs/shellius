# Phase 14: End-to-End Flow Completion

After Phases 1-13, the platform looks complete on the surface but several
flows quietly dead-end: a button exists but the handler hits a missing
endpoint, a form saves to localStorage instead of the DB, an admin tool
exists in the backend but has no UI, or two halves of a feature don't
talk to each other. This phase closes those gaps so every visible action
in the UI either works end-to-end or is removed.

## Findings (audit summary)

The full audit lives in this file's appendix and the per-task descriptions.
At a high level:

### Settings page (highest priority)

| Tab           | Status   | Gap                                                              |
|---------------|----------|------------------------------------------------------------------|
| Organization  | Broken   | No `PUT /api/org` route — saves are silently dropped             |
| CA            | OK       | Generate / rotate / view fingerprint all work                    |
| SSO           | Broken   | No `POST /api/sso` save, no `POST /api/sso/test`; Save disabled  |
| Cloud         | Stub     | "Coming soon" placeholder                                        |
| Notifications | Partial  | Toggle persists to `localStorage` only; no user-pref API         |

### Other pages

- **Policies** — Joi `priority >= 1` but the form's default is `0`, so the
  first save 400s ("priority must be greater than or equal to 1"). Backend
  has `POST /policies/evaluate` (preview tool) but no UI calls it.
- **Users** — Create works but there's no "send invite email" or "password
  reset" path. The backend can mark a user `invited` but nothing emails them.
- **Sessions** — Live list + terminate work; recording playback (asciinema)
  is referenced by an existing `SessionPlayer` but the wiring needs
  verification end-to-end.
- **Certificates** — List + revoke work; there is no UI to download a
  cert file or to surface "expiring soon" alerts.
- **Cloud Connectors** — Backend routes don't exist yet; the page is a
  placeholder for Phase 4. Either implement or hide the nav entry.
- **Notifications** — Backend has full notifications API; the bell in
  the topbar reads it; there's no dedicated `/notifications` page or
  read-all action visible to the user.
- **Web terminal principal** — Form defaults the SSH principal to the
  user's display name (e.g. "Super Admin"). On the target host that's
  not a valid Unix username and sshd refuses cert auth — the *new*
  humanized error in `terminalService` reports this clearly, but the
  form should never accept an invalid principal in the first place.

### Backend orphan endpoints (exist but unused by UI)
- `POST /api/policies/evaluate` — needs an evaluator panel in Policies
- `GET /api/servers/health/summary` — needs a Dashboard widget or button
- `GET /api/certificates/my-certs` — needs a "My Certs" section
- `POST /api/certificates/issue` — by design not exposed (issued via AR)
- Notifications mark-all-read — needs a UI action

## Sub-tasks

| ID  | Agent     | Title                                                    |
|-----|-----------|----------------------------------------------------------|
| 14A | backend   | `org` route + service: get/update org metadata           |
| 14B | backend   | `sso` config route + service: store/get/test SSO         |
| 14C | backend   | `userPreferences` route + service                        |
| 14D | frontend  | Wire Settings tabs to new endpoints + remove TODO banners|
| 14E | frontend+backend | Policy form: priority default 1, min 1, evaluator panel |
| 14F | frontend  | Principal validation in RequestForm + better defaults    |
| 14G | frontend+backend | User invite + password reset flow                      |
| 14H | frontend  | Sessions recording playback verification + search       |
| 14I | frontend  | Certificates: download cert file + expiry banner        |
| 14J | frontend  | Notifications: mark-all-read action + dedicated page    |
| 14K | planner   | Cloud Connectors: decide implement vs hide              |
| 14L | qa        | Smoke-test every page action against the running stack |
| 14M | reviewer  | Security review of new SSO + org + preferences routes  |

## Acceptance

- Every button on Settings either saves to the DB and reflects on reload
  or is removed.
- Policies form can no longer submit `priority < 1`; admins can preview
  a policy against a (user, server) pair before saving.
- New access requests cannot be created with an invalid Unix principal.
- Sessions detail shows recording playback for any recorded session.
- Certificates: users can download their own cert and see an expiry
  warning when within 24 h.
- Notifications: bell + dedicated page + mark-all-read.
- All `[ ]` Phase-14 tasks tick to `[x]` and the `qa` agent's smoke
  test (Task 14L) passes against `https://shellius.yavlabs.com`.
