# ROADMAP — OpenRouter Agentic Intelligence API

## Durum Güncellemesi (2026-03-16)
- ✅ v0.3 teslim edildi: Brave web-search + tenant-isolated RAG (ingest/search/list/delete)
- ✅ v0.5 teslim edildi: orchestrator quality gates + deep-research hardening
- ✅ v0.6 teslim edildi: tenant memory layer + pre-retrieval decision + memory_search tool
- ✅ v0.7 teslim edildi: qmd_search entegrasyonu + memory hotness/retrieval telemetry
- ✅ v0.8 teslim edildi: OpenBB-inspired financial provider fallback + quote harmonization
- ✅ Test paketi 39/39 yeşil

## Faz 1 — Foundation (Hafta 1)
### Hedef
OpenAI-compatible API katmanı + güvenlik temel çizgisi + contract test altyapısı.

### Çıktılar
- `/v1/models`, `/v1/chat/completions` endpointleri
- stream/non-stream destek
- tenant auth + BYOK key management (encrypted)
- rate-limit + request validation

### Exit Criteria
- Contract testleri yeşil
- Kritik security check listesi tamam

---

## Faz 2 — Intelligence Core (Hafta 2)
### Hedef
4-rol orchestrator + düşünme rafinesi.

### Çıktılar
- Planner/Executor/Verifier/Synthesizer çalışır loop
- Poetiq-style candidate/refine döngüsü
- budget guard (token/time/step)
- fallback davranışları

### Exit Criteria
- Orchestrator integration testleri yeşil
- Baseline LLM çağrısına göre kalite artışı gözlemlendi

---

## Faz 3 — Tool Integration (Hafta 3)
### Hedef
Domain toolset'in stabil ve güvenli entegrasyonu.

### Çıktılar
- web search adapter
- wikipedia adapter
- deep-research adapter
- financial deep-search adapter
- rag search adapter
- memory search adapter
- unified tool router + audit logs

### Exit Criteria
- Tool smoke matrix tamam
- Timeout/retry/fallback senaryoları doğrulandı

---

## Faz 4 — Async Research + Observability (Hafta 4)
### Hedef
Uzun görev yürütme ve ürünleşmiş gözlemlenebilirlik.

### Çıktılar
- job queue + worker
- progress event stream
- trace-id, structured logs, run analytics
- admin run inspection endpointleri

### Exit Criteria
- Async E2E akış geçer
- Operasyonel dashboard ile incident triage mümkün

---

## Faz 5 — Hardening + Delivery (Hafta 5)
### Hedef
Prod-ready kalite eşiğine çıkmak.

### Çıktılar
- security hardening pass
- benchmark raporu
- deployment guide
- chatbot entegrasyon örnekleri

### Exit Criteria
- Delivery gate checklist geçer
- İlk pilot entegrasyon canlı testten geçer

---

## V1 Scope Freeze
### V1'e girenler
- OpenAI-compatible chat API
- 4-rol orkestrasyon
- temel thinking-loop
- 7 tool adapter (web/wiki/deep-research/financial/rag/memory/qmd)
- async long-job desteği

### V1 dışı (V2+)
- RL trainer
- multi-region active-active
- plugin marketplace
- custom code execution tool

---

## Başarı Metrikleri (Go-Live)
- API uyumluluk: %95+
- Tool görev başarı oranı: %80+
- p95 latency (sync kısa görev): hedef < 8s
- Kritik güvenlik açık sayısı: 0
- Üretim hata bütçesi (5xx): < %1
