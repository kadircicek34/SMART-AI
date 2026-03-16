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
- `ORCHESTRATOR_MAX_TOOL_PASSES` (varsayılan: 4)
- `ORCHESTRATOR_MAX_REPEATED_TOOL_PASSES` (varsayılan: 2)
- `VERIFIER_MIN_CITATIONS` (varsayılan: 2)
- `VERIFIER_MIN_SOURCE_DOMAINS` (varsayılan: 2)
- `RESEARCH_MAX_QUERIES` (varsayılan: 3)
- `RESEARCH_MAX_CONCURRENT_UNITS` (varsayılan: 2)
- Tenant-specific keys via `/v1/keys/openrouter`
- `BRAVE_API_KEY` (web_search aracı için Brave Search API)
- `ALPHA_VANTAGE_API_KEY` (financial_deep_search için ek quote provider)
- `RAG_STORE_FILE` (tenant bazlı bilgi tabanı dosyası)
- `MEMORY_STORE_FILE` (tenant bazlı memory katmanı dosyası)
- `MEMORY_DEFAULT_CATEGORY` (varsayılan: `note`)
- `MEMORY_MAX_ITEMS_PER_TENANT` (varsayılan: 2500)
- `MEMORY_AUTO_CAPTURE_USER_MESSAGES` (varsayılan: true)
- `MEMORY_HOTNESS_HALF_LIFE_DAYS` (varsayılan: 7)
- `QMD_ENABLED` (varsayılan: true)
- `QMD_COMMAND` (varsayılan: `qmd`)
- `QMD_TIMEOUT_MS` (varsayılan: 15000)
- `QMD_COLLECTION_NAME` (varsayılan: `SMART-AI`)
- `QMD_COLLECTION_PATH` (varsayılan: proje kök dizini)
- `QMD_COLLECTION_AUTO_ADD` (varsayılan: true)
- `QMD_MAX_RESULTS` (varsayılan: 6)

## New endpoints
- `POST /v1/rag/documents` → belge veya URL ingest
- `POST /v1/rag/search` → tenant bilgi tabanında retrieval
- `GET /v1/rag/documents` → tenant belge listesi
- `DELETE /v1/rag/documents/:documentId` → belge silme
- `POST /v1/memory/items` → memory ingest / upsert
- `POST /v1/memory/search` → memory retrieval + pre-retrieval decision
- `GET /v1/memory/items` → tenant memory listesi
- `GET /v1/memory/stats` → tenant memory istatistikleri
- `DELETE /v1/memory/items/:memoryId` → memory silme

## Tool plane updates
- `qmd_search` aracı eklendi (VPS'teki kurulu `qmd` CLI ile lokal repo doküman araması)
- `financial_deep_search` artık OpenBB-pattern fallback ile `stooq + alpha_vantage` kaynaklarını harmonize ediyor
- `deep_research` akışı artık tenant memory + QMD + RAG + web/wiki kaynaklarını birleştiriyor
