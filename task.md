# TASKS — OpenRouter Agentic Intelligence API

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
| Tool adapters | `service/tools/*` | web/wiki/deepresearch/financial adapterları |
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
