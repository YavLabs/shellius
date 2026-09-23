# Chat Notifications

Shellius told people two ways: a bell in the app, and — for two events only —
an email. Everything else, including a break-glass invocation, arrived as a row
somebody had to remember to look at.

Notifications can now also go to **Slack**, **Google Chat**, **Microsoft
Teams**, or any endpoint that accepts JSON. On Slack they can carry working
approve and deny buttons.

## What each platform can actually do

This table is the first thing to read, because the differences are platform
limits rather than missing features and no amount of work changes them short
of building three separate vendor applications.

| | Post messages | Approve / deny buttons | Direct messages |
|---|---|---|---|
| **Slack** (bot token) | yes | **yes** | **yes** |
| **Slack** (incoming webhook) | yes | no | no |
| **Google Chat** | yes | no — link only | no |
| **Microsoft Teams** | yes | no — link only | no |
| **Webhook** (Discord, Mattermost, …) | yes | no | no |

A Google Chat incoming webhook is one-way: it cannot receive an interaction at
all. A Teams **Workflows** webhook posts as the Flow bot and has no interaction
callback. Both would need a full Chat app or bot, which is a separate build per
platform.

Teams also needs the *Workflows* URL specifically. Office 365 connectors were
retired in May 2026, and a connector URL is rejected with an explanation rather
than accepted and left silently broken.

## What is never sent to chat

A chat channel is a **multi-reader** destination. Email is not. That difference
decides what may be routed here.

Six things Shellius sends by email are bearer credentials — an invite, a
password reset, an email verification, an access-request approval link, an SSO
link approval, and an MFA code. Each grants an action *as one named person*.
Posting any of them into a channel would hand every member of that channel the
ability to act as somebody else.

None of them can reach chat, and that holds for three independent reasons:

1. None writes an in-app notification, so none passes through the seam that
   feeds chat.
2. The event catalogue (`backend/src/config/notificationEvents.js`) marks what
   is chat-deliverable, and the service refuses anything else — not just the
   settings screen.
3. **Nothing is auto-serialised.** A chat message is built only from an
   explicit field list written at the call site. A notification's `metadata` is
   never forwarded wholesale, so a field added later — an id, a signed URL, a
   token — cannot quietly begin appearing in somebody's channel. Adding a field
   to a chat message is a visible edit in a reviewed diff.

Chat approvals are built from a fresh decision bound to the *Slack* identity of
whoever pressed the button. The emailed token is never forwarded.

## Routing

A destination subscribes to events and filters them.

- **Events.** Leaving the list empty means the sensible defaults — a request
  needing review, a production bypass, a break-glass, a posture finding, a
  directory sync — not literally everything. One person's own access expiring
  is selectable but not implied.
- **Environments.** Empty means any. An event with no environment (a directory
  sync; a break-glass with no server) does **not** satisfy a filter that names
  one, because a destination configured "production only" that received
  everything would make the filter meaningless.
- **Severity.** An optional floor: `info`, `notice`, `warning`, `critical`.
- **Customers — and this one denies by default.**

### The customer rule

Every in-app notification is already scoped. `postureAlertService` drops
recipients who cannot see the server, because a scoped user must not learn that
an out-of-scope server exists.

A channel has no scope of its own. So if "empty means all customers" — the
convention used for events — a single Slack channel in an MSP organization
would receive every customer's servers, requesters and typed reasons. That
would make cross-customer disclosure the *default*.

Instead, **a destination with no customers selected receives only events that
belong to no customer at all.** To hear about a customer's servers you name
that customer. The settings screen says so where it is configured, because the
inconsistency with the events field is deliberate and otherwise surprising.

## Delivery

Queued, and **at-most-once** — the opposite of the audit sinks, deliberately.
An audit entry is a record and must never be lost, so sinks retry and accept
duplicates. A notification is a notice: the same approval request appearing
twice in a channel is worse than one lost to an outage. Retries happen only
when the platform has told us it did not accept the message.

The enqueue is never awaited on a request-serving path. The Redis client runs
with `maxRetriesPerRequest: null`, which means `queue.add()` *hangs* rather
than failing while Redis is down — awaiting it inside an access-request
submission would hang the submission itself, the exact failure the queue exists
to prevent.

Failures back off and a destination auto-disables after ten consecutive
failures, with the reason shown in the UI and written to the audit log.

### Failures that arrive as success

**Slack answers a refused `chat.postMessage` with HTTP 200 and
`{ok: false}`.** Google Chat does the same with an `error` object. Classifying
by status code — correct for the audit sinks, whose destination is an arbitrary
collector — would read every one of those as a success: the failure counter
would never rise, the destination would never be disabled, the delivery log
would read "delivered", and an organization would believe its approvals were
arriving while nothing had for a week.

Each adapter therefore parses its own response body, and maps the platform's
error strings onto retry, give up, or switch this destination off.

## Credentials

**On Slack, Google Chat and Teams the URL is itself the credential.** Anyone
holding it can post as Shellius; the Teams URL carries a SAS signature in its
query string, and the Google Chat URL its key and token. So `url` is a secret
field here — unlike the audit sinks, where `url` merely names a customer's own
collector and the signing secret is the credential.

Secrets are write-only: responses carry `{ set: true }`, an update that omits
one keeps it, and the UI shows only enough of the URL to tell two destinations
apart.

For the three hosted platforms the destination is pinned to the vendor's
hostname, which is a stronger control than an SSRF check. The generic webhook
adapter — whose destination is arbitrary — uses `guardSsrf` instead, so a
destination cannot be used to make Shellius probe its own network.

Permission: `settings.notifications`, super-admin by default and
non-delegable. An API token must not be able to point notifications somewhere
new.

## Approving from Slack

### Setting up the Slack app

1. Create a Slack app in your workspace.
2. Bot token scopes: `chat:write`, plus `im:write` and `users:read` for direct
   messages.
3. Enable **Interactivity** with a request URL of
   `https://<your host>/api/chat/slack/interactions`.
4. Install it, then configure a destination in Shellius with the bot token, the
   channel, and the app's **signing secret**.

### What authenticates a press

The endpoint cannot sit behind a session — Slack has none. Three things must
hold:

1. **The signature.** HMAC-SHA256 over `v0:{timestamp}:{rawBody}` with the
   signing secret, compared timing-safely, rejected beyond five minutes. It
   covers the exact bytes Slack sent, so the router mounts *before* the global
   body parsers with its own. A missing raw body is refused rather than skipped
   — a future middleware reorder must break this loudly rather than quietly
   turn off its only authentication.
2. **A confirmed identity.** The Slack account must be bound to a Shellius user
   in the organization that owns the destination. The organization comes from
   the workspace, never from the identity row alone: two organizations may
   share one Slack workspace.
3. **The real authorisation path.** The press calls the same
   `accessRequestService.review()` the web UI calls, so being an eligible
   approver, having an active account, the policy's duration cap and the audit
   entry all apply unchanged.

### Linking an account

Link on first use. Pressing a button with an unlinked account is not an error:
it replies with a link, privately, and changes nothing. Following that link
while signed in to Shellius completes the binding — the button press proved the
Slack side, the session proves the other, and neither is enough alone.

**Identities are never matched by email**, because a Slack workspace
administrator can set a member's email address and would otherwise be able to
approve production access as somebody else.

### Duplicate presses

Slack re-sends any interaction it has not had a response to within three
seconds, and each retry is separately signed and entirely valid — so signature
checking does not deduplicate them. A Redis claim on
`team:message_ts:action_id` does, and `review()`'s conditional update is the
backstop. On success the message is replaced, so nobody else reading the
channel can press it afterwards.

### Production

Production requests can be approved from Slack, but the organization switch
`settings.notifications.chatApprovalsAllowProd` defaults to **off**, and a
fresh install starts that way.

It is worth being exact about what turning it on costs, because the obvious
argument is wrong: it is **not** that a button bypasses MFA. There is no MFA
gate on approval in the web UI either. What a chat message adds is visibility
to a whole channel and a press with no typed confirmation. So the production
button carries Slack's own confirmation dialog naming the server, and the audit
entry records `via: 'slack'` with the Slack user and team, making "what was
approved from chat?" a single query.

Denying is never gated. The switch governs granting access, not refusing it.

## Related

- `docs/audit-export.md` — the sinks this borrows its health model from
- `docs/email-delivery.md` — the personal channel, which chat does not replace
- `backend/src/config/notificationEvents.js` — the event catalogue
