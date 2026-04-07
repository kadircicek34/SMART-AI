# TASKS — OpenRouter Agentic Intelligence API

## v1.17 Delta (Delivery Incident Ack + Manual Clear Control Plane) — Tamamlandı
- [x] Yeni özellik: `GET /v1/security/export/delivery-incidents`, `POST /v1/security/export/delivery-incidents/:incidentId/acknowledge`, `POST /v1/security/export/delivery-incidents/:incidentId/clear` endpointleri eklendi
- [x] Dashboard incidents tablosuna ack/clear aksiyonları, incident id/revision ve clear-after görünürlüğü eklendi
- [x] Güvenlik: delivery quarantine artık operator acknowledgement + cooldown sonrası manual clear olmadan fail-open çözülmüyor
- [x] Güvenlik: incident ack/clear aksiyonları optimistic revision guard + zorunlu note ile korunuyor
- [x] Güvenlik: ack alındıktan sonra yeni terminal failure gelirse önceki acknowledgement otomatik sıfırlanıyor
- [x] Telemetry: `security_export_delivery_incident_opened|acknowledged|cleared` audit event tipleri eklendi
- [x] Contract testleri: incident lifecycle, stale revision reject, post-cooldown fail-closed preview ve resolved-history regresyonları yazıldı
- [x] Fresh verification: typecheck + focused contract + full test + audit + smoke + delivery-gate tamamlandı

## v1.16 Delta (Signing Lifecycle Policy + Auto-Rotation Guard) — Tamamlandı
- [x] Yeni özellik: `GET/PUT /v1/security/export/signing-policy` endpointleri eklendi
- [x] Güvenlik: active signing key için auto-rotation / expiry guard / warn window policy uygulandı
- [x] Güvenlik: expired active key ile export ve delivery imzalama fail-closed reddediliyor
- [x] Güvenlik: verify-only signing key retention pruning + JWKS yüzeyi daraltma eklendi
- [x] Dashboard’a signing lifecycle policy formu, health status ve rotate/expire görünürlüğü eklendi
- [x] Contract + unit testleri: lifecycle policy CRUD, auto-rotation, retention prune ve expiry guard regresyonları yazıldı
- [x] Fresh verification: typecheck + focused lifecycle tests + full test + audit + smoke + delivery-gate tamamlandı

## v1.15 Delta (Delivery Egress Policy Plane + Target Preview) — Tamamlandı
- [x] Yeni özellik: `GET/PUT/DELETE /v1/security/export/delivery-policy` ve `POST /v1/security/export/deliveries/preview` endpointlerini eklendi
- [x] Güvenlik: export delivery allowlist’i remote source policy’den ayrıldı; dedicated tenant/deployment delivery-egress policy plane kuruldu
- [x] Güvenlik: allowlist `host + path-prefix` kuralı seviyesine indi; yanlış path hedefleri fail-closed bloklanıyor
- [x] Güvenlik: delivery preview + policy update/reset audit telemetry eklendi
- [x] Dashboard’a delivery policy yönetimi ve preflight target preview akışı eklendi
- [x] Contract testleri: policy CRUD, preview, path-scope enforcement, remote-policy separation regresyonları yazıldı
- [x] Fresh verification: typecheck + focused contract tests + full test + audit + delivery-gate tamamlandı

## v1.14 Delta (Dead-letter Redrive + Anti-Rebinding Pinning) — Tamamlandı
- [x] Yeni özellik: `POST /v1/security/export/deliveries/:deliveryId/redrive` endpointi eklendi
- [x] Dashboard delivery tablosuna dead-letter için manual redrive aksiyonu eklendi
- [x] Güvenlik: `SECURITY_EXPORT_DELIVERY_MAX_MANUAL_REDRIVES` ile bounded replay guard eklendi
- [x] Güvenlik: retry/redrive materyaline hedef fingerprint guard (`origin`, `host`, `path_hash`, `matched_host_rule`) eklendi
- [x] Güvenlik: remote RAG preview/ingest hattına lookup→connect DNS pinning eklendi
- [x] Audit telemetry: `security_export_delivery_redriven` event tipi eklendi
- [x] Yeni testler: redrive lifecycle + replay limit + DNS pinning transport doğrulamaları
- [x] Fresh verification: typecheck + focused regression + full test + audit + delivery-gate

## v1.12 Delta (Resilient Security Export Delivery Queue) — Tamamlandı
- [x] Yeni özellik: `POST /v1/security/export/deliveries` için `mode=async` queue lifecycle eklendi (`queued`, `retrying`, `dead_letter`)
- [x] `GET /v1/security/export/deliveries` endpointine `status` filtresi eklendi
- [x] Güvenlik: retry queue payload’ı AES-256-GCM ile encrypted-at-rest saklanıyor
- [x] Güvenlik: `Idempotency-Key` dedupe + tenant başına aktif async delivery cap eklendi
- [x] Güvenlik/Dayanıklılık: retryable HTTP/network sınıflandırması + exponential backoff + dead-letter audit telemetry eklendi
- [x] Dashboard delivery paneli sync/async mod seçimi ve retry/dead-letter görünürlüğü ile güncellendi
- [x] Yeni contract testleri: async queue success, idempotency reuse/conflict, active-cap, dead-letter, encrypted store doğrulamaları
- [x] Fresh verification: typecheck + full test + audit + delivery-gate

## v1.5 Delta (Async Runtime Cancellation + Model Allowlist + Job Store Hardening) — Tamamlandı
- [x] Yeni özellik: running research job’lar için gerçek cancellation/timeout desteği (AbortSignal chain)
- [x] Job response modeli genişletildi (`started_at`, `completed_at`, `cancellation_reason`)
- [x] Güvenlik: model allowlist enforcement eklendi (`OPENROUTER_ALLOWED_MODELS`, model format validation)
- [x] Güvenlik: model reject girişimleri security audit feed’e eklendi (`api_model_rejected`)
- [x] Güvenlik/Dayanıklılık: idempotency TTL + tenant job store cap eklendi
- [x] Tool/LLM cancellation zinciri genişletildi (OpenRouter + web/wiki/financial/openbb/qmd/mcp)
- [x] Yeni testler: model reject contract testleri + worker timeout/idempotency TTL testleri
- [x] Fresh verification: typecheck + test + audit + delivery-gate

## v1.4 Delta (Security Intelligence Summary + Header Abuse Hardening) — Tamamlandı
- [x] Yeni özellik: `GET /v1/security/summary` endpointi eklendi (riskScore/riskLevel/alertFlags/top IP + byType)
- [x] Dashboard'a Security Risk kartı eklendi (`/v1/security/summary` entegrasyonu)
- [x] Security audit log için detail redaction/sanitize katmanı eklendi (token/key leak azaltımı)
- [x] Authorization/Bearer/Tenant header boyut limitleri eklendi (`431` reject)
- [x] `/ui/session` için oversized API key payload reddi eklendi
- [x] Yeni testler eklendi (`security-summary`, audit redaction/risk summary, header-size reject, oversized UI key)
- [x] Fresh verification: typecheck + test + smoke + audit + delivery-gate

## v1.3 Delta (OpenBB Native Tool Integration) — Tamamlandı
- [x] `openbb_search` tool adapter eklendi (OpenBB `/api/v1` quote/historical + company/world news)
- [x] Orchestrator planner/thinking/verifier akışları OpenBB tool route'u ile güncellendi
- [x] Deep research akışına finans/trading sorgularında OpenBB data pass eklendi
- [x] Config/env yüzeyi genişletildi (`OPENBB_*`)
- [x] Yeni testler eklendi (`service/tests/tools/openbb-search.test.ts` + planner/verifier/policy güncellemeleri)
- [x] Fresh verification: typecheck + test + audit + delivery-gate

## v1.2 Delta (UI Session Auth Hardening) — Tamamlandı
- [x] `POST /ui/session` endpointi eklendi (API key -> kısa ömürlü tenant token)
- [x] `/v1/*` auth middleware APP key + UI session token kabul edecek şekilde genişletildi
- [x] Tenant-scope token enforcement eklendi (cross-tenant access -> 403)
- [x] Chat UI localStorage API key persistence kaldırıldı (`sessionStorage` token modeli)
- [x] Yeni contract testleri eklendi (`service/tests/contract/ui.test.ts`)
- [x] Fresh verification: typecheck + test + audit + delivery-gate

## v1.1 Delta (Control Dashboard + Chatbot UI) — Tamamlandı
- [x] Web control dashboard eklendi (`/ui/dashboard`)
- [x] Kullanıcı chatbot arayüzü eklendi (`/ui/chat`)
- [x] UI statik asset route katmanı eklendi (`service/api/routes/ui.ts`)
- [x] Dashboard metrikleri: health + mcp health + memory stats + rag docs
- [x] Chat UI: model listesi çekme + tenant bazlı `/v1/chat/completions` canlı mesajlaşma
- [x] UI güvenliği: path traversal bloklama + /v1 auth modelini koruma
- [x] Yeni testler eklendi (`service/tests/contract/ui.test.ts`)
- [x] Fresh verification: typecheck + test + audit + delivery-gate

## v1.0 Delta (MCP Resilience Persistence + Ops Flush) — Tamamlandı
- [x] MCP health snapshot persistence eklendi (`service/mcp-health/store.ts`)
- [x] Circuit-breaker seed restore desteği eklendi (restart sonrası state continuity)
- [x] Global mcp-health index persistence scheduler eklendi (`persistDebounceMs`)
- [x] Yeni endpoint eklendi: `POST /v1/mcp/flush`
- [x] Config/env yüzeyi genişletildi (`MCP_HEALTH_PERSIST_*`)
- [x] Yeni testler eklendi (`tests/mcp-health/store.test.ts`, circuit seed testi, contract flush testi)
- [x] Fresh verification: typecheck + test + audit + delivery-gate

## v0.9 Delta (saidsurucu MCP Integrations: mevzuat/borsa/yargı) — Tamamlandı
- [x] `saidsurucu/mevzuat-mcp`, `saidsurucu/borsa-mcp`, `saidsurucu/yargi-mcp` repo analizleri `github-readonly + repomix` ile tamamlandı
- [x] MCP adapter katmanı eklendi (`service/tools/tr-mcp-search.ts`)
- [x] Yeni tool'lar: `mevzuat_mcp_search`, `borsa_mcp_search`, `yargi_mcp_search`
- [x] Planner/thinking/verifier akışları domain-MCP route kararlarıyla güncellendi
- [x] Deep research akışına mevzuat/borsa/yargı MCP kaynakları eklendi
- [x] Policy allowlist + env config yüzeyi güncellendi (MCP URL/timeout/limit)
- [x] Yeni testler eklendi (`service/tests/tools/tr-mcp-search.test.ts` + verifier/policy/deep-research güncellemeleri)
- [x] Fresh verification: typecheck + test + audit + delivery-gate

## v0.8 Delta (OpenBB Financial Runtime Hardening) — Tamamlandı
- [x] OpenBB repo `github-readonly + repomix` ile analiz edildi
- [x] `financial_deep_search` provider fallback modeline geçirildi (Stooq + AlphaVantage)
- [x] Çoklu sembol parser + provider spread analizi eklendi
- [x] Financial quote cache (TTL) eklendi
- [x] Yeni testler eklendi (`service/tests/tools/financial.test.ts`)
- [x] Fresh verification: typecheck + test + audit + delivery-gate

## v0.7 Delta (QMD Search + OpenViking/OpenClaw/Cognee pattern integration) — Tamamlandı
- [x] `qmd_search` tool adapter eklendi (VPS'teki kurulu qmd binary kullanımı)
- [x] QMD collection auto-bootstrap eklendi (`collection list/add --name`)
- [x] Planner/thinking/verifier akışı qmd-aware hale getirildi
- [x] Deep research akışına QMD local source entegre edildi
- [x] Memory hotness scoring eklendi (OpenViking pattern)
- [x] Tenant retrieval telemetry eklendi (`/v1/memory/stats` içinde retrieval metrikleri)
- [x] Yeni testler eklendi (`tests/tools/qmd-search.test.ts`, memory telemetry/hotness testleri)
- [x] Fresh verification: typecheck + test + audit + delivery-gate

## v0.6 Delta (Memory Layer + memU Pattern Integration) — Tamamlandı
- [x] Tenant memory data plane eklendi (`service/memory/*`)
- [x] Memory endpointleri eklendi (`/v1/memory/items`, `/v1/memory/search`, `/v1/memory/stats`)
- [x] `memory_search` tool adapter eklendi ve orchestrator plan/verifier akışına bağlandı
- [x] Chat completions tarafına auto-capture (memory-worthy user message) eklendi
- [x] memU’den alınan pre-retrieval decision pattern’i decision/rewrite akışına uyarlandı
- [x] Yeni testler eklendi (memory service/contract/tool)
- [x] Fresh verification: typecheck + test + audit + delivery-gate

## v0.5 Delta (Quality Gates + Deep Research Hardening) — Tamamlandı
- [x] Verifier kalite kapısı eklendi (minimum citation + source diversity)
- [x] Orchestrator repeated tool-pass loop guard eklendi
- [x] Deep research query budget + concurrency limit eklendi
- [x] Deep research source-level partial failure tolerance eklendi
- [x] Yeni testler eklendi (`tests/tools/deep-research.test.ts`, verifier genişletmesi)
- [x] Fresh verification: typecheck + test + audit + delivery-gate

## v0.3 Delta (RAG + Brave) — Tamamlandı
- [x] `web_search` aracı Brave API ile genişletildi (fallback: DuckDuckGo)
- [x] Tenant izole RAG data-plane eklendi (`service/rag/*`)
- [x] RAG endpointleri eklendi (`/v1/rag/documents`, `/v1/rag/search`, list/delete)
- [x] Planner/Verifier/Routing akışı `rag_search` ile güncellendi
- [x] Contract + unit + security testleri güncellendi (16/16)

## Yürütme Notu
- Bu proje yüksek kapsamlıdır; **design → plan → build → review → test → security → delivery** akışı zorunludur.
- Her chunk bağımsız doğrulanabilir olmalıdır.
- API sözleşmesi ve orkestrasyon davranışı için failing-test-first varsayılandır.

## Dosya Haritası
| Alan | Dosya / Dizin | Amaç |
|---|---|---|
| Ürün tanımı | `prd.md` | Kapsam, karar, mimari çerçeve |
| Mimari kararlar | `decisions.md` | Kritik teknik karar kayıtları |
| Yol haritası | `roadmap.md` | Gün bazlı/sprint bazlı plan |
| API sözleşmesi | `contracts/openai-compatible.yaml` | OpenAI schema uyumlu endpoint sözleşmesi |
| API katmanı | `service/api/*` | Auth, validation, endpointler |
| Orchestrator | `service/orchestrator/*` | Planner/Executor/Verifier/Synthesizer |
| Tool adapters | `service/tools/*` | web/wiki/deepresearch/financial/openbb/rag/memory/qmd + mevzuat/borsa/yargı mcp adapterları |
| Memory plane | `service/memory/*` | memory ingest/retrieve/decision/auto-capture |
| Worker | `service/worker/*` | Uzun araştırma işleri ve event stream |
| Security | `service/security/*` | BYOK, policy, budget guard |
| Testler | `service/tests/*` | Contract, integration, security testleri |

## Isolation Decision
- Çalışma alanı: `projects/openrouter-agentic-intelligence-api`
- Karar: Proje bazlı izolasyon (ayrı klasör)
- Gerekçe: Çok modüllü mimari, uzun soluklu teslim akışı
- Parallel-safe: Evet (bağımsız modüller için)

## Milestone 1 — Discovery / Design (tamamlandı)
- [x] Problem ve hedef netleştirildi
- [x] Seçenekler değerlendirildi (A/B/C)
- [x] Önerilen yön seçildi (Seçenek B)
- [x] Kullanıcı onayı alındı (“Tamam yap”)

## Milestone 2 — Planning / Breakdown (tamamlandı)
- [x] PRD güncellendi
- [x] Dosya haritası oluşturuldu
- [x] Chunk planı çıkarıldı
- [x] Riskler yazıldı
- [x] İlk teknik iskelet scaffold edildi

## Chunk 1 — API Contract + Gateway Skeleton
**Hedef**
- OpenAI-compatible endpoint sözleşmesini sabitlemek.

**Files**
- Create: `contracts/openai-compatible.yaml`
- Create: `service/api/server.ts`, `service/api/routes/*.ts`
- Create: `service/tests/contract/*.test.ts`

**Steps**
- [x] `/v1/models`, `/v1/chat/completions` contractlarını yaz
- [x] request/response validation middleware kur
- [x] stream/non-stream temel yanıt akışı eklendi

**Verification**
- Run: `npm run typecheck`, `npm run dev`, `curl /health`, `curl /v1/models`, `curl POST /v1/chat/completions`
- Expected: typecheck geçer, endpointler JSON response döner

## Chunk 2 — Security Baseline (BYOK + Policy)
**Hedef**
- API key ve tenant güvenliğini üretim çizgisine çekmek.

**Files**
- Create: `service/security/key-store.ts`, `policy-engine.ts`
- Create: `service/api/middleware/auth.ts`, `rate-limit.ts`
- Create: `service/tests/security/*.test.ts`

**Steps**
- [x] key encryption-at-rest (AES-256-GCM file store)
- [x] tenant isolation enforcement (auth + x-tenant-id + tenant-scope data)
- [x] tool allowlist + budget guard

**Verification**
- Run: security tests
- Expected: yetkisiz erişim ve policy bypass senaryolarının bloklanması

## Chunk 3 — Orchestrator Core (4-Role)
**Hedef**
- Planner/Executor/Verifier/Synthesizer döngüsünü çalışır hale getirmek.

**Files**
- Create: `service/orchestrator/{planner,executor,verifier,synthesizer}.ts`
- Create: `service/orchestrator/run.ts`
- Create: `service/tests/orchestrator/*.test.ts`

**Steps**
- [x] step-loop ve stop koşulları (smalltalk short-circuit + runtime budget)
- [x] verifier gate
- [x] fallback/partial answer davranışı

**Verification**
- Run: orchestrator integration tests
- Expected: çok adımlı görevlerde tutarlı completion

## Chunk 4 — Poetiq-Style Thinking Loop
**Hedef**
- Candidate üretimi + değerlendirme + refine mekanizmasını eklemek.

**Files**
- Create: `service/orchestrator/thinking-loop.ts`
- Create: `service/tests/thinking/*.test.ts`

**Steps**
- [x] candidate generation
- [x] scorer/evaluator
- [x] tiebreak ve budget kontrollü refine

**Verification**
- Run: thinking loop tests
- Expected: baseline’e göre kalite metriğinde iyileşme

## Chunk 5 — Tool Plane
**Hedef**
- Web, Wikipedia, DeepResearch ve Financial tool zincirini entegre etmek.

**Files**
- Create: `service/tools/{web,wikipedia,deepresearch,financial}.ts`
- Create: `service/tools/router.ts`
- Create: `service/tests/tools/*.test.ts`

**Steps**
- [x] tool adapter interface
- [x] timeout/retry policy (AbortSignal.timeout)
- [x] tool-call observability (response metadata + job trace alanları)

**Verification**
- Run: tool integration tests
- Expected: her tool için başarı + timeout fallback doğrulaması

## Chunk 6 — Async Research Worker
**Hedef**
- Uzun görevler için job + progress event altyapısını açmak.

**Files**
- Create: `service/worker/*`
- Create: `service/api/routes/jobs.ts`
- Create: `service/tests/worker/*.test.ts`

**Steps**
- [x] job enqueue/dequeue
- [x] progress durum alanları (queued/running/completed/failed)
- [x] result retrieval endpoint

**Verification**
- Run: worker e2e tests
- Expected: async job lifecycle’in uçtan uca geçmesi

## Milestone 3 — Review / Test / Security (tamamlandı)
- [x] Kod review
- [x] Fresh verification
- [x] Security review
- [x] Performance smoke (latency/timeout temel senaryolar)

## Milestone 4 — Delivery (tamamlandı)
- [x] `test-report.md` güncellendi
- [x] `security-report.md` güncellendi
- [x] `delivery.md` final özet yazıldı
- [x] Durum `done` güncellendi

## 10 Günlük Sprint Planı
1. Gün: API contract freeze + endpoint skeleton
2. Gün: Auth, tenant, rate-limit
3. Gün: Key store + policy engine
4. Gün: Planner/Executor temel akış
5. Gün: Verifier/Synthesizer + stop logic
6. Gün: Thinking loop v1
7. Gün: Web + Wikipedia tool adapter
8. Gün: DeepResearch + Financial adapter
9. Gün: Async worker + event stream
10. Gün: E2E, security hardening, delivery prep

## Bekleyen Kararlar
- OpenRouter model fallback zinciri (varsayılan model listesi)
- İlk sürümde deep-research tool’un sync mi async mi expose edileceği
- Finans tool erişim policy’sinin tenant bazlı açma/kapama seviyesi

## 2026-03-17 Ek Sprint — Risk Closure
- [x] `/ui/session` için anti-bruteforce/rate-limit katmanı
- [x] `POST /ui/session/revoke` endpoint + UI logout akışı
- [x] MCP health persistence’i shared-backend destekli abstraction'a taşı (http/file)
- [x] Testler + delivery gate

## 2026-03-17 Ek Sprint — External repo synthesis
- [x] `mcporter` ile `github-readonly` + `repomix` üzerinden 3 referans repo analiz edildi
- [x] Orchestrator planına stage checklist eklendi
- [x] Stage status takibi (pending/running/done) eklendi
- [x] Memory semantic linking (`relatedMemoryIds`) eklendi
- [x] Test + audit + delivery gate çalıştırıldı

## 2026-03-19 Ek Sprint — Async research lifecycle + security hardening
- [x] `POST /v1/jobs/research` için `Idempotency-Key` desteği eklendi
- [x] `GET /v1/jobs` endpointi ile tenant job listesi eklendi
- [x] `POST /v1/jobs/:jobId/cancel` endpointi eklendi
- [x] Tenant active-job cap eklendi (`RESEARCH_MAX_ACTIVE_JOBS_PER_TENANT`)
- [x] Idempotency conflict protection + header validation eklendi
- [x] Job error redaction katmanı eklendi
- [x] Security event feed, research-job event tipleriyle genişletildi
- [x] Contract + worker testleri eklendi
- [x] Typecheck + test + audit + smoke + delivery gate çalıştırıldı
