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
- Sync chat + Async research jobs (`/v1/jobs/research`)
- Stream/non-stream cevap desteği
- **RAG knowledge base** (tenant izole ingest + retrieval)
- **Brave Search destekli web_search** (fallback: DuckDuckGo)
- **Verifier kalite kapıları** (minimum citation + source diversity)
- **Loop guard** (tekrarlayan tool-pass kırıcı)
- **Deep research budget/concurrency kontrolleri**
- **Tenant Memory Layer** (memorizasyon + retrieval + auto-capture)
- **QMD Local Search entegrasyonu** (VPS'teki kurulu `qmd` ile proje doküman araması)
- **Memory hotness scoring + retrieval telemetry** (OpenViking pattern)
- **OpenBB-inspired financial provider fallback** (Stooq + AlphaVantage quote harmonization)
- **Türk domain MCP entegrasyonu** (Mevzuat MCP + Borsa MCP + Yargı MCP via mcporter)
- **MCP Dayanıklılık Katmanı** (circuit breaker + adaptive timeout + kalıcı health snapshot + health endpointleri)

## Klasörler
- `contracts/` → API sözleşmeleri
- `service/api/` → gateway, middleware, routes
- `service/orchestrator/` → planner/executor/verifier/synthesizer
- `service/tools/` → web/wiki/deep-research/financial/rag/memory/qmd/mcp adapters
- `service/rag/` → ingest/chunk/retrieval/runtime store
- `service/memory/` → memory ingest/retrieve/decision/auto-capture
- `service/security/` → key-store, policy, budget
- `service/worker/` → async job runtime
- `service/tests/` → contract + security + unit testleri

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
# job başlat
curl -X POST http://127.0.0.1:8080/v1/jobs/research \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a' \
  -H 'content-type: application/json' \
  -d '{"query":"Türkiye AI ekosisteminin 2025 trendlerini karşılaştırmalı analiz et"}'

# job durumunu al
curl http://127.0.0.1:8080/v1/jobs/<job_id> \
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
