# /docker-up

Manage the Shellius Docker stack.

## Arguments

`$ARGUMENTS` — Optional: `dev` (default), `prod`, `down`, `restart`, `logs`, `status`.

## Steps

1. **Parse mode** from `$ARGUMENTS` (default: `dev`)

2. **Execute based on mode**

   `dev`:
   ```bash
   docker compose -f docker-compose.dev.yml up -d
   ```

   `prod`:
   ```bash
   docker compose -f docker-compose.yml up -d
   ```

   `down`:
   ```bash
   docker compose -f docker-compose.dev.yml down
   docker compose -f docker-compose.yml down
   ```

   `restart`:
   ```bash
   docker compose -f docker-compose.dev.yml restart
   ```

   `logs`:
   ```bash
   docker compose -f docker-compose.dev.yml logs -f --tail 100
   ```

   `status`:
   ```bash
   docker compose -f docker-compose.dev.yml ps
   ```

3. **Verify health** (for `dev` and `prod` modes)
   ```bash
   # Wait for services to be healthy
   docker compose -f docker-compose.dev.yml ps
   curl -s http://localhost:3001/api/health | jq .
   ```

4. **Print status** — show running containers, ports, and health status.
