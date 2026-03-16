# Service Runtime

## Commands
- `npm run dev` → local server
- `npm run typecheck` → TypeScript checks
- `npm test` → contract/security tests

## Required env (minimum)
- `APP_API_KEYS`
- `MASTER_KEY_BASE64`

## Optional env
- `OPENROUTER_API_KEY` (global fallback)
- Tenant-specific keys via `/v1/keys/openrouter`
