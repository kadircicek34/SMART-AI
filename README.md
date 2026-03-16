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

## Klasörler
- `contracts/` → API sözleşmeleri
- `service/api/` → gateway, middleware, routes
- `service/orchestrator/` → planner/executor/verifier/synthesizer
- `service/tools/` → web/wiki/deep-research/financial/rag adapters
- `service/rag/` → ingest/chunk/retrieval/runtime store
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
- memU (memory/retrieval scoring yaklaşımı)
