# /lint

Run linters across Shellius codebase.

## Arguments

`$ARGUMENTS` — Optional: `--fix`, `backend`, `frontend`, or empty for all.

## Steps

1. **Parse arguments**
   - `--fix` flag enables auto-fix mode
   - Scope: `backend`, `frontend`, or both

2. **Check for TypeScript files** (should never exist)
   ```bash
   find backend/src frontend/src -name "*.ts" -o -name "*.tsx" 2>/dev/null
   ```
   If any found, report as ERROR.

3. **Run ESLint**

   If `backend` or empty:
   ```bash
   cd backend && npx eslint src/ --ext .js
   # or with --fix:
   cd backend && npx eslint src/ --ext .js --fix
   ```

   If `frontend` or empty:
   ```bash
   cd frontend && npx eslint src/ --ext .js,.jsx
   # or with --fix:
   cd frontend && npx eslint src/ --ext .js,.jsx --fix
   ```

4. **Run Prettier check**
   ```bash
   npx prettier --check "backend/src/**/*.js" "frontend/src/**/*.{js,jsx}"
   # or with --fix:
   npx prettier --write "backend/src/**/*.js" "frontend/src/**/*.{js,jsx}"
   ```

5. **Report results** — errors, warnings, files checked, auto-fixes applied.
