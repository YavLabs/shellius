# RDP session recording

SSH sessions have been recorded since the terminal hub was built. RDP sessions
were not, and the Sessions page said so: *"Replay is not available for RDP
sessions."* That is backwards for an access-management product — RDP is the
higher-risk protocol, because a desktop session is not constrained to the
things a shell audit trail would show.

This document is mostly about why the RDP pipeline looks nothing like the SSH
one, because the difference is not a design preference.

## Why it is a different mechanism

An SSH session's bytes pass through Node. `terminalService.openRecordingWriter`
tees them into an asciinema v2 cast and streams that straight into object
storage; nothing touches a disk.

**RDP bytes never pass through Node at all.** The browser speaks the Guacamole
protocol to guacd, which speaks RDP to the host and draws the session. Node
proxies an opaque WebSocket. It cannot record what it cannot see.

So guacd has to do the recording, which forces three consequences:

1. **Recording is switched on before the connection opens.** It is a guacd
   connection parameter and cannot be added to a connection in flight. That is
   earlier than the `Session` row exists, so the file is named after a freshly
   generated recording id and the `Session` row stores which id is its own
   (`metadata.recordingId`).
2. **The file lands on guacd's filesystem**, so guacd and the backend must
   share a directory. The compose files mount one into both.
3. **The file is only complete when guacd closes it**, which is slightly after
   the client's WebSocket goes away.

## Why a sweeper, not an upload on close

Uploading when the session ends would race guacd's last flush — storing a
truncated recording and then deleting the rest of it. It would also lose any
recording whose session ended while Shellius was restarting.

So `jobs/rdpRecordingIngest.js` sweeps every minute instead. A file is taken
when it has been untouched for 30 seconds **and** its session has ended. Both
conditions are needed: an idle desktop draws nothing for minutes, so a stale
mtime on its own does not mean the session is over.

For each finished file the backend encrypts it (the same envelope as an SSH
cast, `utils/recordingCrypto.js`), uploads it to
`sessions/{orgId}/{sessionId}.guac`, writes `Session.recordingKey`, and only
then deletes the plaintext. That order is deliberate: deleting before the key
is written loses the recording, whereas a crash between upload and key means
the next sweep re-uploads over the same key, which is harmless.

## Keystrokes are deliberately not recorded

`recording-include-keys` is off and there is no setting to turn it on.

Guacamole can record keystrokes as well as the display. Doing so captures every
password typed into the remote desktop — including ones typed into applications
Shellius knows nothing about — which would turn an audit artefact into a
credential store held at rest. The display stream already shows what was done.

## What a recording cannot tell you

- **Nothing before the connection opened.** A connection that fails during
  authentication produces a zero-byte file, which is discarded.
- **Nothing typed.** See above.
- **Nothing about a session where recording was off.** Recording needs object
  storage configured and a shared directory. Where either is missing, RDP still
  works and is simply not recorded — refusing the session instead would make a
  missing bucket look like a broken gateway. The Sessions page says which.

## Unattributable recordings

A file whose recording id matches no `Session` row is retried for 24 hours —
the row is written a moment after guacd creates the file, so a brief mismatch
is normal — and then **deleted**, loudly, at `error` level.

This is the one place the feature destroys data on purpose. Such a file cannot
be served to anyone, shown to anyone, or governed by anyone's retention policy.
Keeping a screen recording that nothing can account for is worse than losing
it.

## Retention

`RECORDING_RETENTION_DAYS` (default 30) applies to RDP and SSH alike.

Note for anyone who ran an earlier release: **retention was not actually
enforced for anything in object storage.** `sessionCleanup.pruneOldRecordings`
only ever looked at `Session.recordingPath`, the older on-disk form, while
every recording written since the terminal hub was rewritten uses
`recordingKey`. Recordings therefore accumulated in the bucket indefinitely
while the product documented a 30-day window. `pruneOldStoredRecordings` fixes
that, and will delete anything already past the window on its first run after
upgrade — check the window is what you want before upgrading if that matters
to you.

## Configuration

Nothing to turn on: recording starts working once object storage is configured
and the compose volume exists.

| Variable | Meaning |
|---|---|
| `RDP_RECORDINGS_DIR` | where the backend reads finished recordings |
| `GUACD_RDP_RECORDINGS_DIR` | the same directory as guacd sees it |
| `RDP_RECORDING_ENABLED` | set to `false` to switch it off entirely |
| `RECORDING_RETENTION_DAYS` | how long recordings are kept (default 30) |

The two directory settings differ only when the backend runs outside Docker. In
development the backend is on the host, so it reads `./data/rdp-recordings`
while guacd writes to `/var/lib/shellius/rdp-recordings` — the same directory
through a bind mount.

## Playback

`frontend/src/components/sessions/RdpSessionPlayer.jsx`, using
`Guacamole.SessionRecording` from `guacamole-common-js`, which was already a
dependency for the live client. It takes a `Blob`, so the whole recording is
fetched before playback — there is no streaming entry point.

The SSH player's command list has no RDP equivalent: it is derived by parsing
the cast's text, and a desktop session has no command stream to extract.
