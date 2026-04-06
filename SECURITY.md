# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability in Shellius, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, email us at: **security@yavlabs.com**

Include:

- Description of the vulnerability
- Steps to reproduce
- Impact assessment (e.g. credential disclosure, privilege escalation, RCE)
- Suggested fix (if any)

We will acknowledge your report within 48 hours and provide a timeline for a fix.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Security Best Practices

When deploying Shellius:

- Always use HTTPS (TLS) in production. Terminate TLS at Traefik or Nginx.
- Generate strong, unique values for `JWT_SECRET`, `JWT_REFRESH_SECRET`, `SERVER_ENCRYPTION_KEY`, and `AGENT_SHARED_SECRET` -- never reuse defaults or example values.
- Use a dedicated PostgreSQL user with minimal privileges (the migrations only need owner rights on the Shellius database).
- Restrict network access to PostgreSQL, Redis, and `guacd` to the internal Docker network. Never expose them to the public internet.
- Keep Docker images and dependencies up to date. Watch for advisories on `ssh2`, `prom-client`, `prisma`, and `guacd`.
- Enable audit logging review -- the `AuditLog` table is immutable; ship it to a SIEM if you have one.
- Configure SSO with enforced MFA where possible.
- Rotate the SSH CA periodically via Settings -> CA Management -> Rotate. Existing certificates will continue to validate until their TTL expires.
- Backup PostgreSQL and the recordings volume (`scripts/backup-db.sh`, `scripts/backup-recordings.sh`).
- Set `RECORDING_RETENTION_DAYS` according to your compliance requirements; the `sessionCleanup` job will prune older recordings hourly.
- Protect the Prometheus `/api/metrics` endpoint by setting `METRICS_TOKEN` (callers must send `Authorization: Bearer <token>`).
- Treat the CA private key as the most sensitive asset in the system. It is encrypted at rest with `SERVER_ENCRYPTION_KEY`; if that key leaks, the CA must be rotated and all certificates re-issued.
