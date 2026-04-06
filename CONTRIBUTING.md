# Contributing to Shellius

Thank you for your interest in contributing to Shellius. This document provides guidelines and instructions for contributing.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Reporting Bugs](#reporting-bugs)
- [Suggesting Features](#suggesting-features)
- [Development Setup](#development-setup)
- [Code Style](#code-style)
- [Pull Request Process](#pull-request-process)

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to conduct@yavlabs.com.

## Reporting Bugs

Before filing a bug report, please check existing issues to avoid duplicates.

When reporting a bug, include:

1. **Environment** -- OS, Docker version, browser (if frontend-related), Go version (if TUI-related)
2. **Steps to reproduce** -- clear, numbered steps
3. **Expected behavior** -- what you expected to happen
4. **Actual behavior** -- what actually happened
5. **Logs** -- relevant error messages or stack traces (redact any secrets, certificates, and tokens)
6. **Screenshots** -- if applicable for UI issues

**Important:** If the bug is a security vulnerability, do **not** open a public issue. See [SECURITY.md](SECURITY.md) instead.

## Suggesting Features

Feature requests are welcome. Open an issue with:

- A clear description of the feature
- The problem it solves or the use case it addresses
- Any ideas for implementation (optional)

## Development Setup

### Prerequisites

- Node.js 20+
- Go 1.22+ (for the TUI)
- Docker and Docker Compose v2+
- OpenSSH client (`ssh-keygen` is required by the SSH CA service)
- Git

### Getting started

```bash
# Clone the repository
git clone https://github.com/yavlabs/shellius.git
cd shellius

# Set up environment
cp .env.prod.example .env.prod
# Fill in required values (see .env.prod.example for documentation)

# Start infrastructure (PostgreSQL, Redis, guacd)
docker compose -f docker-compose.dev.yml up -d postgres redis guacd

# Backend
cd backend
npm install
npx prisma generate
npx prisma migrate dev
npm run dev

# Frontend (in a separate terminal)
cd frontend
npm install
npm run dev

# TUI (in a separate terminal)
cd tui
go mod tidy
go run ./cmd/shellius --server http://localhost:3001
```

### Running tests

```bash
# Backend tests
cd backend && npm test

# Frontend tests
cd frontend && npm test

# TUI tests
cd tui && go test ./...
```

## Code Style

### General

- Use **ES modules** (`import`/`export`) everywhere on the JavaScript side. No CommonJS `require()`.
- Use `async/await` consistently. No raw `.then()` chains.
- Environment variables via `.env` files. Never commit secrets.

### Frontend

- **No TypeScript.** All frontend code must be `.js` or `.jsx`.
- Use functional components with hooks only. No class components.
- UI components are built with shadcn/ui and Tailwind CSS.
- Lucide React for icons. No emojis in the UI.
- Aesthetic target: Cloudflare / Linear / Vercel — clean, minimal, monochrome with accent colors.

### Backend

- Route handlers must be thin. Delegate business logic to the service layer.
- All database queries must include `org_id` scoping. The `tenant` middleware enforces this.
- All API responses follow the shape: `{ success: boolean, data?: any, error?: string|object, meta?: object }`.
- Joi for request validation. Winston for structured logging.
- Audit middleware on every mutation -- use `ACTIONS.*` from `auditService.js` for the action constant.

### TUI

- Bubble Tea idioms: model/Update/View, `tea.Cmd` for side effects, `tea.ExecProcess` for handing off to subprocesses.
- Lipgloss for styling, Bubbles for common components.
- Cross-compile via `make build-all`.

### Security rules

- Never log or print secrets, private keys, certificate contents, RDP passwords, or refresh tokens.
- Never store SSH private keys server-side after returning them to the user.
- Never store RDP passwords in plaintext -- always use `utils/crypto.js` (AES-256-GCM).
- Never skip `org_id` scoping in database queries.
- Never bypass the production-server approval flow except via the documented `super_admin` role.
- Never commit `.env`, `.env.prod`, or any file containing real secrets.

## Pull Request Process

1. **Fork** the repository and create your branch from `main`.
2. **Write clear commit messages** that explain the "why" behind changes.
3. **Add or update tests** for any new functionality or bug fixes.
4. **Ensure all tests pass** before submitting.
5. **Update documentation** if your changes affect the public API, configuration, or setup.
6. **Open a pull request** with:
   - A clear title summarizing the change
   - A description explaining what was changed and why
   - Reference to any related issues (e.g., "Fixes #42")
7. **Address review feedback** promptly.

### PR checklist

- [ ] Tests pass (`npm test` in `backend/` and `frontend/`, `go test ./...` in `tui/`)
- [ ] No new TypeScript files introduced
- [ ] No secrets, certificates, or tokens in the diff
- [ ] Database queries include `org_id` scoping where applicable
- [ ] API responses follow the standard `{ success, data, error, meta }` shape
- [ ] Audit log entries added for new mutating endpoints
- [ ] Documentation updated if needed
