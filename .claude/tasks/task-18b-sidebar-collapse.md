# Task 18B: Sidebar collapse — avatar, icon alignment, group dividers

**Agent:** frontend
**Status:** [ ] Pending
**Blocks:** 18Q-B, 18R-B
**Blocked By:** None
**Model:** sonnet

## Symptoms
1. Collapsing the sidebar removes the user avatar entirely
2. Nav icons not centered in the collapsed rail (they cling left)
3. Section group headings disappear AND the visual grouping
   (separator lines / vertical gaps) disappears too, so all items
   read as one undifferentiated list

## Fix in `frontend/src/components/layout/Sidebar.jsx`

### Avatar
In collapsed mode, render an avatar-only block:
```jsx
{collapsed ? (
  <Tooltip>
    <TooltipTrigger asChild>
      <button className="mx-auto mt-2 flex h-9 w-9 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
        {initials(user?.name)}
      </button>
    </TooltipTrigger>
    <TooltipContent side="right">
      {user?.name} · {user?.role}
    </TooltipContent>
  </Tooltip>
) : (
  /* existing expanded card */
)}
```

### Icon alignment
Every NavItem container in collapsed mode should be:
```jsx
className={cn(
  'group flex items-center py-2 text-sm transition-colors',
  collapsed ? 'mx-2 justify-center rounded-md px-0' : 'rounded-md px-3 gap-3',
  isActive ? 'bg-accent/60 text-primary' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
)}
```
Strip `gap-3` in collapsed mode (no label to space against). Use
`justify-center` so the icon sits centered in the rail.

### Section dividers in collapsed mode
Replace `SectionHeader` in collapsed mode with a horizontal divider
so the visual grouping survives:
```jsx
function SectionDivider({ collapsed }) {
  if (!collapsed) return null;
  return <div className="mx-2 my-3 h-px bg-border/60" />;
}
```
Render `<SectionDivider collapsed={collapsed} />` between sections in
addition to (or instead of, when collapsed) the existing
`SectionHeader`.

## Acceptance
- Avatar visible (as a circle with initials) in collapsed mode with
  a tooltip showing name + role
- All nav icons cleanly centered in the collapsed rail
- Section grouping clearly visible via horizontal dividers between
  collapsed groups
- Tooltips on every collapsed nav item (already wired via
  TooltipProvider — verify they still show the right label)
