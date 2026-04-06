# /build

Build Shellius artifacts. Optionally scope to a specific layer.

## Arguments

`$ARGUMENTS` — Optional: `backend`, `frontend`, `tui`, `docker`, or empty for all.

## Steps

1. **Parse scope** from `$ARGUMENTS`

2. **Build scoped artifacts**

   If `backend` or empty:
   ```bash
   cd backend && npm run build
   ```

   If `frontend` or empty:
   ```bash
   cd frontend && npm run build
   ```
   Report build size: `du -sh frontend/dist`

   If `tui` or empty:
   ```bash
   cd tui && make build-all
   ```
   Report binary sizes for each platform.

   If `docker`:
   ```bash
   docker compose build --no-cache
   ```
   Report image sizes: `docker images | grep shellius`

3. **Report results** — build success/failure, output sizes, any warnings.
