# Task 17E: Notification Badge UI Fix

**Agent:** frontend
**Status:** [ ] Pending
**Blocks:** 17Q-E, 17R-E
**Blocked By:** None
**Model:** sonnet

## Symptom
The notification bell badge in the topbar is bigger than the icon
itself. Mess.

## Fix
`frontend/src/components/layout/NotificationBell.jsx`:
- Bell icon stays at `h-5 w-5`. Container uses `relative`.
- Badge: `absolute -top-1 -right-1 h-4 min-w-4 px-1 rounded-full
  bg-destructive text-destructive-foreground text-[10px] font-semibold
  flex items-center justify-center` — fits comfortably on the corner
  of the icon.
- Cap displayed count at `9+` when `unreadCount > 9`.
- When `unreadCount > 0`, swap the icon to `BellRing` (filled-style)
  from lucide; else use plain `Bell`. Gives a clear at-a-glance
  visual cue.
- Add `aria-label={\`${unreadCount} unread notifications\`}` for
  screen readers.

## Acceptance
- Badge cleanly overlays the bell corner, never larger than the icon.
- Icon switches to filled when there are unread notifications.
- Hovering shows a tooltip with the count.
- Works at all topbar heights.
