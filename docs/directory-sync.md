# Directory Sync (SSO deprovisioning)

Shellius provisions accounts on the way in: the first SSO sign-in creates a
user, links an identity and grants the provider's default role. Until 2.0
there was no path on the way out. Someone removed from Okta on Friday still
had a Shellius account on Monday, and — before the fix that ships alongside
this — still had a live SSH certificate.

Directory sync closes that. On a schedule it asks the identity provider who
still works here, and acts on the people who do not appear.

> **Read this first if you are about to arm it.** This is the only code in
> Shellius that can disable a person's account without a human deciding to.
> Everything below is about the difference between *"the directory says this
> person has left"* and *"I could not find this person in the directory"*.

## Why it is a reconcile job and not SCIM

SCIM is what an RFP names, and it was considered and deliberately traded away
for 2.0. SCIM is an **inbound authenticated endpoint** that an external system
may use to create, modify and delete accounts — a new attack surface on a
privileged-access platform, secured by a bearer token that lives in someone
else's IdP configuration. A reconcile job is outbound, reads only, and can be
switched off at any moment without the IdP noticing. For a first release of
deprovisioning that is the right trade. SCIM remains worth revisiting.

The cost of the choice: OIDC has no directory API. There is no
provider-agnostic way to ask "does this user still exist?", so this is a
per-provider adapter registry, and a provider without an adapter gets an
explicit "not available" rather than a silent no-op.

## Adapters

| Adapter | Reads | Credential | Reports disabled? |
|---|---|---|---|
| `entra` | Microsoft Graph `GET /users` | App registration, **application** permission `User.Read.All`, admin-consented | Yes (`accountEnabled`) |
| `okta` | `GET /api/v1/users` | Read-only admin API token (SSWS) | Yes (`DEPROVISIONED`, `SUSPENDED`) |
| `google` | Admin SDK Directory `users.list` | Service account with domain-wide delegation for `admin.directory.user.readonly`, impersonating an admin | Yes (`suspended`, `archived`) |
| `github` | `GET /orgs/{org}/members` | Token with `read:org` | No — membership is binary |

Auth0, generic OIDC and SAML have no adapter. The settings screen says so and
why.

Two notes on the adapters that bite in practice:

- **Google requires `adminEmail`.** The Directory API answers for a user, not
  for a service account, so a configuration without an admin to impersonate
  fails with a confusing 400. It is validated up front instead.
- **GitHub asks a narrower question**: not "does this person exist?" but "are
  they still in the org?". That is the right question, because
  `SsoConfig.allowedOrgs` already makes org membership the condition for
  signing in at all. GitHub also exposes no member emails, so matching there
  is by id alone.

## The identifier problem

This is the sharpest edge in the feature, and the reason `UserIdentity` has an
`externalId` column separate from `subject`.

**Microsoft Entra issues a pairwise `sub` claim.** It is derived per
application, so the `sub` Shellius stored when a user signed in is a value that
appears *nowhere* in Microsoft Graph. An adapter that compared Graph ids
against stored subjects would match **zero rows** — and a deprovisioning job
reads "matched nothing" as "everyone has left the company".

The value that matches `/users/{id}` is the **`oid` claim**, which Shellius now
records at sign-in as `externalId`.

What each provider stores:

| Provider | `subject` (`sub`) | `externalId` | Backfilled by migration? |
|---|---|---|---|
| GitHub | numeric user id | same | **Yes** — `sub` provably is the directory id |
| Google | directory user id | same | **Yes** |
| Entra | pairwise, per-application | the `oid` claim | **No — cannot be reconstructed** |
| Okta | user id on an org auth server; the *login* on a custom one | `sub`, but only when it has Okta's `00u…` shape | **No** |

So after upgrading, an Entra or Okta org will see accounts with no known
directory id. **That is safe by construction**: an identity whose
`externalId` is null is never judged. Those rows fill in as each user next
signs in, and the run report counts them as `unknownIdentities` so the gap is
visible rather than silent.

Where the directory carries emails, an identity with no directory id can still
be matched by email — the union of the two is deliberate, because matching by
either errs towards *not* suspending.

## The safety valves

In the order they apply, all of them in
`backend/src/services/directory/directorySyncService.js`:

1. **The credential is tested before the directory is listed.** A run that
   cannot authenticate never reaches the code that acts on an empty answer.
2. **An empty directory aborts.** Nobody works at a company with no staff.
3. **A directory that has shrunk by more than half** since the last successful
   run aborts. Real attrition does not look like that; broken paging does.
4. **Only users with a `UserIdentity` for *this* config are judged.** Local
   accounts and other providers' users are invisible to the run.
5. **A user whose directory id is unknown is never judged.** Null is not
   absence.
6. **A user with an identity on another *active* provider is left alone.**
   They can still legitimately sign in.
7. **Absence must persist past `graceHours`** (default 24) before anything
   happens. Findings persist between runs, so the clock is real; someone who
   reappears has their finding resolved and is never touched.
8. **The run aborts if candidates exceed `maxSuspendCount` (default 25) or
   `maxSuspendPercent` (default 10%) of active users.** Both, because a
   percentage is meaningless in a small org and a count is meaningless in a
   large one. Below three candidates the percentage is not applied at all —
   otherwise a five-person team could never deprovision anybody.
9. **The last active super admin is never suspended**, whatever the directory
   says.
10. **`dryRun` is on by default.** Turning it off is a deliberate act, and it
    is recorded in the audit log as such.

A run that aborts is the feature working. It is audited as
`directory_sync.aborted`, separately from `directory_sync.failed`, and it
notifies administrators — an aborted run always says what it saw and that
nothing was changed.

## Rollout

The order below is the one to follow, and step 3 is not optional.

1. **Configure and test the credential.** The test button proves the
   credential in isolation; nothing else runs until it passes.
2. **Leave `action: 'flag'` and `dryRun: true`.** Run it manually and read the
   report.
3. **Check `unknownIdentities` and `matchedByExternalId`.** A run where
   `matchedByExternalId` is 0 and `matchedByEmail` is high means the directory
   ids have not been learned yet — for Entra, that is every user who has not
   signed in since the upgrade. Wait. Deprovisioning on email alone is not
   what you want.
4. **Read the findings.** Each one names a person and how long they have been
   missing. Anyone in that list who should not be is a bug in the
   configuration, not a leaver.
5. Only then set `action: 'suspend'` and turn `dryRun` off.

To test the abort path deliberately — worth doing once — break the credential
and run it. The run must fail without suspending anyone.

## What suspension does

`suspended` status plus the full cascade from `userService.revokeAllAccessFor`:
refresh-token families revoked, `sessionsValidFrom` bumped, live terminal
sessions ended, **active SSH certificates revoked**, pending and approved
access requests revoked, and API tokens revoked.

That last set is the part that matters and the part that did not work before
2.0: `certificateService.verify()`, which every host calls through
`check-principals` on every SSH connection, did not consult the user's status.
A suspended user's already-issued certificate kept authenticating until it
expired. Automatic deprovisioning that does not revoke access is not
deprovisioning, so that fix ships as part of the same release.

Suspension is reversible from the Users screen. Nothing here deletes anything.

## Operations

- Scheduled by `backend/src/jobs/directorySync.js`: a 15-minute tick that runs
  each sync only when its own `intervalHours` has elapsed. Each sync holds a
  Redis lock, which — unlike the audit sinks — does **not** fail open: two
  reconciles racing could act on the same people twice and skew the valves, so
  a lock that cannot be taken means waiting for the next tick.
- Every decision is audited: `directory_sync.run`, `.aborted`, `.failed`,
  `.flagged`, `.deprovisioned`, `.skipped`, `.resolved`.
- Findings and run history are kept and shown in the UI. A skip records *why*
  — "Not suspended: this is the last active super admin" is a finding, not a
  silence.
- Permission: `settings.sso`, super-admin by default and non-delegable, so an
  API token cannot arm a deprovisioning job.

## Related

- `docs/sso-configuration.md` — provider setup
- `docs/auth-hardening.md` — sessions, linking, the suspend cascade
- `backend/src/services/directory/externalId.js` — the per-provider rule for
  what a directory id is, with the reasoning inline
