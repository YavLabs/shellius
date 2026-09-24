# Collector auto-update

Shellius can keep the posture collector up to date across a fleet without
anyone connecting to a host. This document is mostly about the ways that could
go wrong, because the feature is, stated plainly:

> Shellius downloads a script to every managed host and runs it as root.

Everything below exists to make that sentence safe to say out loud. If you are
deciding whether to turn it on, read "What it cannot do" and "Turning it on"
and skip the rest.

**It is off by default**, for every existing organization and every new one.

## Why it exists

`serverAgentStatus` has marked hosts "Update available" for a while, and the
fix has always been "reinstall". Reinstalling means an SSH session per host,
which needs either a stored credential or a mintable certificate — so a fleet
behind NAT, or one bootstrapped with no saved credentials (which is the normal
state, because certificate access was the whole point), is one you cannot
reach. Those hosts stay on an old collector indefinitely.

Pull solves that: the host already calls home every five minutes, so it can
ask whether there is anything newer. No inbound path, no stored secret.

## What it cannot do

These are structural, not policy:

- **It only ever replaces one file**: `/usr/local/sbin/shellius-posture-collect`.
  Not sshd config, not the CA public key, not `check-principals`, not the
  heartbeat agent, not sudoers. A broken collector makes posture go quiet; a
  broken `check-principals` decides whether anyone can log into anything, so
  it is not updatable this way at all.
- **The host cannot ask for anything.** `GET /api/hosts/collector-update`
  takes no parameters — no version, no path, no name. A host receives whatever
  the rollout job decided for that specific host, or nothing.
- **An unverified script is never executed.** Verification failure is a
  refusal with no fallback path; see "Signing".
- Updating Shellius itself is a separate thing and is not automatic. That is
  still `./update-shellius.sh <tag>`, run by a person on the host.

## Signing

Each installation generates an RSA-4096 keypair on first use
(`ReleaseSigningKey`, one row, `scope = 'global'`). The private half is
encrypted at rest with the same envelope as the SSH CA and is decrypted in
memory only while signing. The public half is written to each host at
bootstrap as `/etc/shellius/release-key.pub`.

**Why sign at all, when the host fetched it over TLS from a server it was
configured to trust?** Because those are different statements. TLS says "these
bytes came from whatever is currently answering at that hostname". The
signature says "these bytes were produced by this installation's key and have
not been altered since" — which still holds through a reverse proxy, a caching
layer, a corporate TLS-terminating middlebox or a mirror, all of which are
ordinary in the networks this product is deployed into.

**Why RSA and not Ed25519?** The verifier is `openssl dgst -sha256 -verify` in
a bash script on an arbitrary Linux host. That works back to OpenSSL 1.0.2.
Verifying Ed25519 from the openssl CLI needs `pkeyutl -rawin`, which is 3.0+.
A signature scheme a host cannot check becomes a check that gets skipped, and
that is worse than no signature at all.

A host with no `release-key.pub` does not install updates. It refuses and says
so in its journal, rather than falling back.

## How a rollout works

A rollout is per organization and targets the collector version this
installation ships.

1. The job (`jobs/collectorRollout.js`, every 5 minutes) finds candidate
   hosts: eligible for the collector, **currently reporting**, and on an older
   version. Hosts that are already silent are excluded — offering to them
   would make their continued silence look like an update failure, and a fleet
   with a few dead machines would halt every rollout.
2. It orders them by a stable hash of `(serverId, targetVersion)` and offers
   the update to the first *canary percent* of the fleet (default 10%, never
   fewer than one host, so a small organization is not left "rolling" having
   offered the update to nobody).
3. Hosts poll `GET /api/hosts/collector-update` every 15 minutes (with up to
   5 minutes of jitter, so ninety hosts do not ask in the same second). A host
   with an offer fetches, verifies and installs it.
4. The host refuses any version that is not newer than the one it is running.
   The signature covers the script and nothing else — no nonce, no timestamp —
   so a validly-signed older bundle replayed by something sitting between the
   host and the server would otherwise verify perfectly and downgrade it.
5. The host proves the new collector works before trusting it: it runs it once
   **as the unprivileged collector account** and requires JSON on stdout, not
   merely a zero exit. If that fails, the previous collector is restored. The
   replacement is staged in the destination directory so the final move is a
   same-filesystem rename; staged in /tmp it would often be a cross-device
   copy onto the live path, which is not atomic.
6. Shellius learns the outcome the only way it can — the host carries on
   reporting. A host back on the target version is `verified`. A host still on
   the old version after the grace period (45 minutes) is `rolled_back`. A
   host that stops reporting entirely is `failed`.
7. The rollout widens (10 → 25 → 50 → 100) only when the current step has no
   pending hosts and the dwell time has passed. If more than 20% of judged
   hosts failed — and at least two did, because one failure out of one host is
   100% and would make the feature unusable for small organizations — the
   rollout **halts** and records why.

A halted rollout is not restarted automatically. That is deliberate: a
health gate that re-arms itself on the next tick is not a health gate.

## Division of responsibility for failures

| What went wrong | Who notices | What happens |
|---|---|---|
| Download corrupted or tampered | Host | Refuses, keeps the old collector, logs it |
| No signing key on the host | Host | Refuses to install anything at all |
| New collector crashes or prints nothing | Host | Restores the previous collector immediately |
| New collector installs but stops reporting | Server | Attempt marked `failed`, rollout halts |
| New collector reports, but the host reverted | Server | Attempt marked `rolled_back`, rollout halts |
| Shellius downgraded mid-rollout | Server | Rollout cancelled — it targets a version no longer shipped |

The host handles what it can see immediately; the server handles what only
becomes visible over time. The blast radius of anything the host cannot catch
is bounded by the canary step.

## Turning it on

Administration → Posture, or `PUT /api/posture/settings`:

```json
{ "collectorAutoUpdate": true, "collectorCanaryPercent": 10 }
```

Requires `posture.settings`. Hosts bootstrapped before this release have no
`/etc/shellius/release-key.pub` and will not update until they are
re-bootstrapped — the installer writes the key, and there is deliberately no
way to push a signing key to a host out of band.

## Turning it off

Set `collectorAutoUpdate` to false. Any rollout in progress is cancelled on
the next tick. Hosts that have already been offered an update may still take
it: the switch governs new offers, and reaching onto a host to withdraw one is
not something this feature can do. To stop a specific host, remove
`/etc/shellius/release-key.pub` or disable `shellius-collector-update.timer`
on it.

## What is deliberately not here

- **Updating `check-principals` or the heartbeat agent.** See "What it cannot
  do".
- **Updating Shellius itself.** Different risk, different mechanism; a
  container cannot reliably replace itself, and the honest options all involve
  something privileged on the host.
- **A second, time-delayed rollback on the host.** The host rolls back what it
  can observe (a collector that will not run). "Installed fine, then stopped
  reporting" is detected server-side and bounded by the canary, because
  implementing it twice would mean two rollback paths on a machine we cannot
  test from here — and the second one would be the untested one.
