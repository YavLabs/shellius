## What does this change?

<!-- A short description, and the issue it closes (e.g. "Closes #123"). -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation
- [ ] Refactor / chore

## How was this tested?

<!-- Commands you ran, and what you verified manually. -->

- [ ] `cd backend && npm test`
- [ ] `cd frontend && npm test`
- [ ] `cd tui && go test ./...`
- [ ] Manually verified in a running deployment

## Security checklist

Shellius handles SSH certificates, credentials, and multi-tenant data. Confirm
each item that applies to this change:

- [ ] No secrets, private keys, certificate contents, or tokens are logged
- [ ] No SSH private key is persisted server-side after being returned to a user
- [ ] All new database queries are scoped by `org_id`
- [ ] New routes are guarded with `requirePermission(...)`, never a role-name check
- [ ] Mutations emit an audit log entry
- [ ] Production access still requires approval unless the requester holds
      `access.prod_bypass` **and** the org switch is enabled
- [ ] Personal vault items remain filtered by `ownerId`

## Notes for reviewers

<!-- Anything non-obvious: migrations, config changes, upgrade steps. -->
