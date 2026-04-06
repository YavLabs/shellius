# /dev-setup

Set up the local development environment for Shellius from scratch.

## Steps

1. **Check prerequisites**
   ```bash
   node --version    # >= 20.0.0
   npm --version
   docker --version
   docker compose version
   git --version
   go version        # >= 1.22
   ```
   If any are missing, print instructions and exit.

2. **Create .env file**
   ```bash
   if [ ! -f .env ]; then
     cp .env.example .env
   fi
   ```

3. **Generate development secrets**
   ```bash
   # Generate random secrets and write to .env
   SERVER_ENCRYPTION_KEY=$(openssl rand -hex 32)
   JWT_SECRET=$(openssl rand -hex 32)
   JWT_REFRESH_SECRET=$(openssl rand -hex 32)
   ```
   Update the corresponding values in `.env`.

4. **Start infrastructure**
   ```bash
   docker compose -f docker-compose.dev.yml up -d postgres redis
   ```

5. **Wait for PostgreSQL**
   ```bash
   until pg_isready -h localhost -p 5432; do sleep 1; done
   ```

6. **Install backend dependencies**
   ```bash
   cd backend && npm install
   ```

7. **Run Prisma migrations**
   ```bash
   cd backend && npx prisma migrate dev
   ```

8. **Generate Prisma client**
   ```bash
   cd backend && npx prisma generate
   ```

9. **Seed database**
   ```bash
   cd backend && npx prisma db seed
   ```

10. **Install frontend dependencies**
    ```bash
    cd frontend && npm install
    ```

11. **Install TUI dependencies**
    ```bash
    cd tui && go mod download
    ```

12. **Print summary**
    ```
    Shellius dev environment ready!
    
    Backend API:   http://localhost:3001
    Frontend:      http://localhost:5173
    PostgreSQL:    localhost:5432
    Redis:         localhost:6379
    
    Default admin: admin@shellius.local / Shellius2024!
    
    Start services:
      Backend:  cd backend && npm run dev
      Frontend: cd frontend && npm run dev
    ```

## Error Handling

- If Docker is not running, print: "Docker daemon is not running. Start Docker and try again."
- If port 5432 is in use, print: "Port 5432 is in use. Stop the existing PostgreSQL or change DB_PORT in .env."
- If npm install fails, try `rm -rf node_modules package-lock.json && npm install`.
