# /test

Run tests for Shellius. Optionally scope to a specific layer or file.

## Arguments

`$ARGUMENTS` — Optional: `backend`, `frontend`, `tui`, `<file-path>`, or empty for all.

## Steps

1. **Parse scope** from `$ARGUMENTS`

2. **Run scoped tests**

   If `backend` or empty:
   ```bash
   cd backend && npm test -- --coverage
   ```

   If `frontend` or empty:
   ```bash
   cd frontend && npm test -- --coverage
   ```

   If `tui` or empty:
   ```bash
   cd tui && go test -cover ./...
   ```

   If a file path is provided:
   ```bash
   # Detect layer from path and run that file
   cd backend && npm test -- <file>
   # or
   cd frontend && npm test -- <file>
   # or
   cd tui && go test <package>
   ```

3. **Report results**
   - Total tests: passed / failed / skipped
   - Coverage percentage per layer
   - List any failing tests with error details
