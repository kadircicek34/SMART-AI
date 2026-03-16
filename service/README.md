# Service Runtime

## Commands
- `npm run dev` → local server
- `npm run typecheck` → TypeScript checks
- `npm test` → contract/security/unit tests

## Required env (minimum)
- `APP_API_KEYS`
- `MASTER_KEY_BASE64`

## Optional env
- `OPENROUTER_API_KEY` (global fallback)
- `OPENROUTER_MAX_RETRIES` (varsayılan: 2)
- `OPENROUTER_RETRY_BASE_DELAY_MS` (varsayılan: 400)
- `OPENROUTER_RETRY_MAX_DELAY_MS` (varsayılan: 4000)
- Tenant-specific keys via `/v1/keys/openrouter`
- `BRAVE_API_KEY` (web_search aracı için Brave Search API)
- `RAG_STORE_FILE` (tenant bazlı bilgi tabanı dosyası)

## New endpoints
- `POST /v1/rag/documents` → belge veya URL ingest
- `POST /v1/rag/search` → tenant bilgi tabanında retrieval
- `GET /v1/rag/documents` → tenant belge listesi
- `DELETE /v1/rag/documents/:documentId` → belge silme
