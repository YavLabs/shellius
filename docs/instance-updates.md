# Updating Shellius itself

Two things live here: knowing that an update exists, and applying one.

The first is built in and safe. The second is **opt-in, off by default, and
deliberately not something the application can do** — read "Why the app cannot
update itself" before deciding whether you want it.

## Knowing an update exists

Administration → Updates shows the running version, the latest published
release, and the collector versions across your fleet. It needs the
`settings.updates` permission (super admin by default, non-delegable).

The check is one unauthenticated GET to the releases API, cached for six
hours. **It sends nothing**: no organization id, no install id, not even the
running version. A self-hosted security tool that phones home is a different
product, so the request carries nothing and there is a test that asserts it.

Turn it off entirely with `UPDATE_CHECK_ENABLED=false`. Air-gapped installs
are a supported configuration, not a fault; the screen says "checks are turned
off" rather than showing an error.

## Applying an update, by hand

This is the default and it is a perfectly good end state:

```bash
cd ~/shellius
./scripts/backup-db.sh          # do this first; there is no undo endpoint
./scripts/update-shellius.sh v2.1.0
```

`update-shellius.sh` already does the careful parts: it backs up the database
and the code before touching anything, keeps the current images tagged
`rollback-<version>`, builds the new ones while the old ones keep serving, runs
`prisma migrate deploy`, and only then swaps the folders and restarts. If the
new version does not come up healthy it prints the rollback command.

## Why the app cannot update itself

A container cannot reliably replace itself. The two obvious ways around that
both end in the same place:

- **Mount the Docker socket into the application.** That is root on the host,
  for the web app, permanently.
- **Give the application a shell on its host.** Same thing, fewer steps.

Either one hands the web application root on the machine that holds the SSH
CA. For a product whose entire pitch is the elimination of standing privilege,
that is not a trade worth making for the convenience of a button.

So the split is: the application can record an *intent* to upgrade, and
nothing more. A short script you read and chose to install does the
privileged half.

## The optional helper

`scripts/shellius-self-update.sh` polls the API every five minutes, and when it
finds a request it runs `update-shellius.sh`. Nothing about how an upgrade
happens is reimplemented — the helper only decides *when*.

### What it refuses

- Anything that is not plain semver. The version reaches a shell, so
  `2.1.0; rm -rf /` is rejected in the API **and** in the script.
- **Any version that is not newer than what is running.** If the application
  were compromised, the most useful thing an attacker could ask for through
  this channel is a downgrade to a published release with a known
  vulnerability. Both halves refuse it independently: a control that exists in
  only one of two places is one bug away from not existing. Rolling back is
  done on the host, with `./update-shellius.sh --rollback`.
- Anything at all if `update-shellius.sh` is not where it expects.

### Installing it

1. Issue a **helper credential** (Administration → Updates, or
   `POST /api/updates/self/helper-token` with `settings.updates`). It is shown
   once; nothing stores the plaintext, and issuing another one invalidates the
   previous.

   > It is deliberately **not** an API token, and the reason is concrete
   > rather than stylistic. `settings.updates` is non-delegable, and
   > `middleware/apiTokenAuth` strips every non-delegable permission from
   > every API token — a service account's included, by design and with a test
   > pinning it. A helper authenticating as an API client would have received
   > 403 on every call, for ever. The alternative fix, an exception in that
   > stripping, would have reopened the "no API token ever holds a
   > non-delegable permission" guarantee that `settings.storage`,
   > `settings.email`, `audit.sinks` and service-account management all rely
   > on. A credential that reaches exactly three endpoints and nothing else in
   > the product is the narrower answer.

   What a holder of it can do, in full: learn whether an upgrade has been
   requested, claim it, and report how it went. It cannot read or write any
   organization's data, cannot create a request, and cannot choose a version —
   the version comes from a request a human made through the permission-gated
   endpoint.

2. On the host running Shellius:

   ```bash
   sudo install -m 0755 ~/shellius/scripts/shellius-self-update.sh \
        /usr/local/sbin/shellius-self-update
   sudo install -m 0644 ~/shellius/scripts/shellius-self-update.service \
        /etc/systemd/system/
   sudo install -m 0644 ~/shellius/scripts/shellius-self-update.timer \
        /etc/systemd/system/

   sudo mkdir -p /etc/shellius
   sudo tee /etc/shellius/self-update.env >/dev/null <<'EOF'
   SHELLIUS_API_URL=https://shellius.example.com
   SHELLIUS_TOKEN_FILE=/etc/shellius/self-update-token
   SHELLIUS_APP_DIR=/root/shellius
   EOF
   sudo chmod 600 /etc/shellius/self-update.env

   printf '%s' 'shup_...' | sudo tee /etc/shellius/self-update-token >/dev/null
   sudo chmod 600 /etc/shellius/self-update-token

   sudo systemctl daemon-reload
   sudo systemctl enable --now shellius-self-update.timer
   ```

3. Check it before relying on it:

   ```bash
   sudo /usr/local/sbin/shellius-self-update --dry-run
   ```

   Within five minutes the Updates screen should show the helper as present.

### Using it

With a helper present, the Updates screen offers to request an upgrade.
Pressing it writes a row; the helper picks it up within five minutes and
reports back. Progress appears on the same screen.

The claim is single-use at the database level, so two helpers — or one helper
whose previous run has not finished — cannot start two upgrades on the same
host.

### Removing it

```bash
sudo systemctl disable --now shellius-self-update.timer
sudo rm -f /usr/local/sbin/shellius-self-update /etc/shellius/self-update-token
```

Revoke the credential as well (`DELETE /api/updates/self/helper-token`).
Requests then sit unclaimed and the screen goes back to showing the command.

## One more thing worth saying out loud

These records are **installation-wide**, not per organization: there is no
`org_id` on them. On a multi-tenant install, one organization's
`settings.updates` holder requests an upgrade that restarts the service for
everybody, with no notice to the others. That follows the precedent already
set by `settings.storage` ("shared by every organization on this install"),
but it is worth knowing before you hand `settings.updates` to a second
organization's super admin.

## What this does not cover

- **Deployments that are not `update-shellius.sh`.** Kubernetes, Coolify and
  hand-rolled systemd installs each have their own upgrade path; the helper is
  a thin wrapper around one specific script and does not pretend otherwise. On
  those, use the notification half and upgrade the way you already do.
- **Automatic upgrades.** There is no "always install the latest" switch, and
  that is deliberate: an unattended upgrade of the component holding the SSH
  CA, on someone else's schedule, is not a feature. Collector updates are
  automatic; this is not.
- **Downgrades.** See above.
