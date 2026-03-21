# SMART-AI — OpenRouter Agentic Intelligence API

OpenRouter tabanlı modelleri ajan orkestrasyonu + tool kullanımı ile güçlendirip **OpenAI-compatible API** olarak sunan servis.

## Vizyon
Ham LLM çağrısı yerine:
- Planlayan (Planner)
- Tool kullanan (Executor)
- Kanıtı kontrol eden (Verifier)
- Cevabı sentezleyen (Synthesizer)

bir akış ile daha güvenilir ve araştırmacı bir zeka katmanı sağlanır.

## Öne Çıkanlar
- OpenAI-compatible endpointler (`/v1/models`, `/v1/chat/completions`)
- Tenant bazlı güvenlik (`Authorization` + `x-tenant-id`)
- Tenant bazlı OpenRouter API key saklama (AES-256-GCM encrypted-at-rest)
- Policy kontrollü tool erişimi
- Sync chat + Async research jobs (`/v1/jobs/research`) + job list/cancel lifecycle (`/v1/jobs`, `/v1/jobs/:jobId/cancel`)
- Stream/non-stream cevap desteği
- **RAG knowledge base** (tenant izole ingest + retrieval)
- **Brave Search destekli web_search** (fallback: DuckDuckGo)
- **Verifier kalite kapıları** (minimum citation + source diversity)
- **Loop guard** (tekrarlayan tool-pass kırıcı)
- **Deep research budget/concurrency kontrolleri**
- **Research job runtime hardening** (Idempotency-Key TTL + tenant active-job cap + AbortSignal destekli gerçek cancel/timeout + cancellation reason telemetry)
- **Model allowlist policy** (`OPENROUTER_ALLOWED_MODELS` + model format doğrulaması + security audit event)
- **Tenant Memory Layer** (memorizasyon + retrieval + auto-capture)
- **QMD Local Search entegrasyonu** (VPS'teki kurulu `qmd` ile proje doküman araması)
- **Memory hotness scoring + retrieval telemetry** (OpenViking pattern)
- **OpenBB native tool entegrasyonu** (`openbb_search`: equity quote/historical + company/world news)
- **OpenBB-inspired financial provider fallback** (Stooq + AlphaVantage quote harmonization)
- **Türk domain MCP entegrasyonu** (Mevzuat MCP + Borsa MCP + Yargı MCP via mcporter)
- **MCP Dayanıklılık Katmanı** (circuit breaker + adaptive timeout + kalıcı health snapshot + health endpointleri)
- **Security Audit Event Feed** (`/v1/security/events`) + dashboard güvenlik olay görünürlüğü
- **Security Risk Summary** (`/v1/security/summary`) + tenant bazlı risk skoru / alarm bayrakları
- **Header abuse guard** (Authorization / tenant header boyut limitleri + UI oversized key koruması)

## Klasörler
- `contracts/` → API sözleşmeleri
- `service/api/` → gateway, middleware, routes
- `service/orchestrator/` → planner/executor/verifier/synthesizer (+ stage checklist metadata)
- `service/tools/` → web/wiki/deep-research/financial/openbb/rag/memory/qmd/mcp adapters
- `service/rag/` → ingest/chunk/retrieval/runtime store
- `service/memory/` → memory ingest/retrieve/decision/auto-capture
- `service/security/` → key-store, policy, budget
- `service/worker/` → async job runtime
- `service/tests/` → contract + security + unit testleri
- `service/web/` → control dashboard + chatbot UI statik frontend

## Hızlı Başlangıç
```bash
cd service
cp .env.example .env
npm install
npm run typecheck
npm test
npm run dev
```

## Auth Header’ları
Her `/v1/*` isteğinde:
- `Authorization: Bearer <APP_API_KEYS içinde tanımlı key>`
- `x-tenant-id: <tenant-id>`

## Tenant OpenRouter Key Kaydı
```bash
curl -X POST http://127.0.0.1:8080/v1/keys/openrouter \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a' \
  -H 'content-type: application/json' \
  -d '{"apiKey":"sk-or-v1-..."}'
```

## RAG Belge Ingest
```bash
curl -X POST http://127.0.0.1:8080/v1/rag/documents \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a' \
  -H 'content-type: application/json' \
  -d '{
    "documents": [
      {
        "title": "SMART-AI API",
        "content": "Chat endpoint /v1/chat/completions ..."
      }
    ]
  }'
```

## RAG Search
```bash
curl -X POST http://127.0.0.1:8080/v1/rag/search \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a' \
  -H 'content-type: application/json' \
  -d '{"query":"chat completions endpoint"}'
```

## Memory Ingest
```bash
curl -X POST http://127.0.0.1:8080/v1/memory/items \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a' \
  -H 'content-type: application/json' \
  -d '{
    "items": [
      {
        "category": "preference",
        "content": "Ben toplantıları sabah saatlerinde yapmayı tercih ederim."
      }
    ]
  }'
```

## Memory Search
```bash
curl -X POST http://127.0.0.1:8080/v1/memory/search \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a' \
  -H 'content-type: application/json' \
  -d '{"query":"Benim toplantı tercihim neydi, hatırla"}'
```

## MCP Health (Resilience Ops)
```bash
curl http://127.0.0.1:8080/v1/mcp/health \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a'

curl -X POST http://127.0.0.1:8080/v1/mcp/flush \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a'
```

## Security Event Feed
```bash
curl 'http://127.0.0.1:8080/v1/security/events?limit=20' \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a'

curl 'http://127.0.0.1:8080/v1/security/summary?window_hours=24&top_ip_limit=5' \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a'
```

## Web UI (Control Dashboard + Chat UI)
Sunucu kalktıktan sonra:
- `http://127.0.0.1:8080/ui/dashboard`
- `http://127.0.0.1:8080/ui/chat`

UI, API Key ve Tenant ID ile `POST /ui/session` üzerinden kısa ömürlü oturum tokenı üretir. API key tarayıcıda kalıcı saklanmaz; `/v1/*` çağrıları session token + tenant header ile yapılır.

Yeni güvenlik akışı:
- `/ui/session` endpoint’inde brute-force koruması (IP+tenant bazlı geçici lock)
- `POST /ui/session/revoke` ile aktif token revoke/logout desteği
- Login hata mesajı normalize edilmiştir (`Invalid credentials`).
- UI state-changing endpoint’lerde Origin allowlist kontrolü (`UI_ALLOWED_ORIGINS`) desteklenir.
- `/ui/dashboard` ve `/ui/chat` yanıtlarında CSP + güvenlik header’ları uygulanır.
- Dashboard artık API key’i localStorage’da tutmaz; chat ile aynı kısa ömürlü session token modeli kullanılır.
- Dashboard, `/v1/security/summary` ile 24h risk seviyesi + alarm bayraklarını da gösterir.

## QMD Collection Bootstrap (opsiyonel manuel)
```bash
# service dizininden bir üstte proje kökü varsayılır
cd ..
qmd collection add . --name SMART-AI
qmd search "memory endpoint" -c SMART-AI --json -n 5
```

## Chat Completion
```bash
curl -X POST http://127.0.0.1:8080/v1/chat/completions \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a' \
  -H 'content-type: application/json' \
  -d '{
    "model":"deepseek/deepseek-chat-v3.1",
    "messages":[{"role":"user","content":"NVDA son bilanço etkisini analiz et"}],
    "stream": false
  }'
```

## Async Deep Research Job
```bash
# job başlat (idempotent)
curl -X POST http://127.0.0.1:8080/v1/jobs/research \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a' \
  -H 'Idempotency-Key: ai-research-2026-03-19-01' \
  -H 'content-type: application/json' \
  -d '{"query":"Türkiye AI ekosisteminin 2025 trendlerini karşılaştırmalı analiz et"}'

# job listesi
curl 'http://127.0.0.1:8080/v1/jobs?limit=20&status=running' \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a'

# job durumunu al
curl http://127.0.0.1:8080/v1/jobs/<job_id> \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a'

# çalışan/queued job iptal et
curl -X POST http://127.0.0.1:8080/v1/jobs/<job_id>/cancel \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a'
```

## Referans Esin Kaynakları
- CrewAI (plan/execute, MCP patterns)
- OpenRAG (ingest + retrieval çalışma modeli)
- Open Deep Research (workflow + araştırma akışı yaklaşımı)
- Qwen-Agent (tool-call + runtime patternleri)
- Deer-Flow (stability middleware patternleri)
- memU (memory/retrieval decision yaklaşımı)
- OpenViking (memory hotness + retrieval stats pattern)
- OpenClaw (qmd process/manager + fallback safety pattern)
- Cognee (memory graph retrieval/memify patternleri)
- QMD (lokal markdown index + hızlı arama)
- OpenBB (provider registry/fetcher lifecycle ile finansal tool hardening)
- saidsurucu/mevzuat-mcp (Türk mevzuat MCP entegrasyonu)
- saidsurucu/borsa-mcp (BIST/TEFAS/KAP MCP entegrasyonu)
- saidsurucu/yargi-mcp (Türk yargı/emsal karar MCP entegrasyonu)
