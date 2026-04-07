# Task 16G: Env Defaults + Email Template Docs

**Agent:** devops + planner
**Status:** [x] Done
**Blocks:** 16Q-G
**Blocked By:** 16A, 16B, 16C
**Model:** sonnet

## Deliverables
- `.env.prod.example` — add the new SMTP_* and SSO_* env vars with
  comments explaining precedence (UI overrides env).
- `docs/email-templates.md` — structure + add-a-template guide + screenshots
- `docs/sso-configuration.md` — per-provider setup walkthrough with
  env-var cheatsheet and UI wizard screenshots
- `docs/smtp-configuration.md` — same for SMTP

## Acceptance
- `cat .env.prod.example` shows every env var the backend reads.
- Docs render cleanly in GitHub markdown preview.
