# Task 13C: Audit & Unwrap All Frontend Services

**Agent:** frontend
**Status:** [x] Done
**Blocks:** None
**Blocked By:** None

## Objective
Apply the same envelope-unwrap fix to every frontend service so callers
never have to defensively read `data.entity || data.items || data || []`.
Pages should be able to write `const x = await getX(id); x.field`.

## Pattern
For routes that return `{ success, data: { entity }, meta }`:
```js
const unwrap = (r) => r.data?.data?.entity ?? r.data?.data ?? r.data;
```
For paginated list routes returning `{ success, data: result, meta }`:
```js
api.get(...).then((r) => ({ data: r.data?.data ?? r.data, meta: r.data?.meta }));
```

## Status by service

| Service                       | Unwrapped? | Notes                                  |
|-------------------------------|------------|----------------------------------------|
| `serverService.js`            | ✅         | Done in earlier round                  |
| `groupService.js`             | ✅         | Done — fixes Groups blank list         |
| `accessRequestService.js`     | ✅         | Task 13A                               |
| `customerService.js`          | ✅         | `unwrapCustomer` for get/create/update; list returns `data` directly |
| `userService.js`              | ✅         | `unwrapUser` for get/create/update     |
| `policyService.js`            | ✅         | `unwrapPolicy` for get/create/update; `getMyAccess` unwraps `accessibleServers` |
| `certificateService.js`       | ✅         | `unwrapCert` for get/revoke            |
| `sessionService.js`           | ✅         | `unwrapSession` for get/terminate      |
| `auditService.js`             | ✅         | Already returns full envelope; pages read `r.data.items`/`r.meta` correctly |
| `caService.js`                | ✅         | `getPublicKey` unwraps `caKeyPair`; `getStatus`/`rotate` flat |
| `notificationService.js`      | ✅         | Returns `{notifications, unreadCount, meta}` directly; context updated |

## Acceptance
- Spot-check each list and detail page in the running app: every field on
  the API response renders, no silent `-` or "Unknown" placeholders when
  data exists.
