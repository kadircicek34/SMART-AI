# SECURITY REPORT — SMART-AI v0.5

## Kapsam
Bu iterasyonda kontrol edilen güvenlik/dayanıklılık yüzeyleri:
- AuthN/AuthZ (Bearer API key + tenant header)
- Tenant isolation (key-store + RAG data plane)
- Input validation (zod)
- Secret management (AES-256-GCM)
- Rate limit + runtime/tool budget
- LLM provider dayanıklılığı (OpenRouter retry)
- **Orchestrator kalite kapıları** (citation floor + source diversity)
- **Tool loop dayanıklılığı** (repeated pass guard)
- Dependency güvenliği (`npm audit`)

## Kontrol Sonuçları
| Alan | Durum | Not |
|---|---|---|
| Auth / Authorization | ✅ | `/v1/*` auth zorunlu; tenant id zorunlu |
| Validation | ✅ | Chat ve RAG endpoint body validation aktif |
| Secrets | ✅ | tenant OpenRouter key encrypted-at-rest |
| Tenant Isolation | ✅ | RAG doküman/chunk erişimi tenant scope ile sınırlandı |
| Abuse Guard | ✅ | rate-limit + max step/tool/runtime bütçesi |
| Provider Resilience | ✅ | 429/5xx kontrollü retry, non-retryable 4xx fail-fast |
| Evidence Quality Gate | ✅ | min citation + source diversity kontrolü |
| Loop Guard | ✅ | tekrarlayan tool-pass imzası tespitinde kırma |
| Dependencies | ✅ | `npm audit --omit=dev` sonucu: 0 vulnerability |

## Yeni Güvenlik/Dayanıklılık Notu
- Verifier yalnızca özet uzunluğuna değil kaynak çeşitliliğine de bakıyor.
- Deep research query genişlemesi env budget ile sınırlı (`RESEARCH_MAX_QUERIES`).
- Paralel araştırma birimi env ile sınırlı (`RESEARCH_MAX_CONCURRENT_UNITS`).

## Kalan İyileştirme Alanları
1. Circuit breaker + retry telemetry (SLO takibi)
2. RAG URL ingest için allowlist / SSRF sertleştirme katmanı
3. Merkezi (Redis) distributed rate-limit ve queue
4. KMS entegrasyonu (env master key yerine)

## Sonuç
Sistem güvenlik tabanı korunarak araştırma/orkestrasyon tarafında kalite ve dayanıklılık kapıları güçlendirildi; tüm kontroller yeşil.
