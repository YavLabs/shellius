# Task 12D: Documentation

**Agent:** devops + planner
**Status:** [ ] Pending
**Blocks:** None
**Blocked By:** None

## Objective
Create comprehensive documentation covering architecture, SSH CA flow, host setup, bootstrapping, deployment, TUI usage, and API reference.

## Deliverables
- `docs/architecture.md` — system architecture overview: component diagram, data flow, technology choices, security model
- `docs/ssh-ca-flow.md` — detailed SSH CA certificate flow: key generation, signing process, certificate lifecycle, host configuration for TrustedUserCAKeys and AuthorizedPrincipalsCommand
- `docs/host-setup.md` — step-by-step guide for configuring target hosts: sshd_config changes, CA public key installation, principals command setup, testing connectivity
- `docs/bootstrap-guide.md` — initial setup guide: first admin user creation, CA key pair generation, first server registration, first access request walkthrough
- `docs/deployment.md` — deployment guide: prerequisites, environment variables, docker compose setup, Traefik configuration, SSL certificates, DNS setup, production checklist
- `docs/tui-usage.md` — TUI client guide: installation (download binary), configuration, login flow, navigating hosts, requesting access, connecting to servers, troubleshooting
- `docs/api-reference.md` — complete API reference: all endpoints grouped by resource, request/response schemas, authentication, error codes, pagination, rate limiting

## Acceptance Criteria
- All documentation is written in clear, concise Markdown
- Architecture diagram uses Mermaid or ASCII art (no external image dependencies)
- SSH CA flow diagram shows the complete certificate lifecycle
- Host setup guide is testable step-by-step (a sysadmin can follow it)
- Bootstrap guide gets a new installation from zero to first SSH connection
- Deployment guide covers both development and production setups
- API reference covers every endpoint with example requests and responses
- All documents cross-reference each other where relevant
