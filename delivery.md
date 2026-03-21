# DELIVERY — SMART-AI v1.5 (Async Runtime Cancellation + Model Allowlist Hardening)

## Özet
Bu koşumda en yüksek etkili günlük iyileştirme olarak **async runtime güvenlik/dayanıklılık sertleştirmesi** teslim edildi.

Teslimin odağı:
- running research job’lar için gerçek cancel/timeout (AbortSignal zinciri),
- deployment-level model allowlist enforcement,
- idempotency/job store büyümesini sınırlayan TTL + prune mekanizması.


## 2026-03-21 Teslim paketi (Async runtime cancellation + model allowlist)
### Yapılanlar
1. **Yeni özellik — gerçek running cancel/timeout**
   - Worker katmanında running job için `AbortSignal` tabanlı yürütme eklendi.
   - `RESEARCH_JOB_TIMEOUT_MS` ile otomatik timeout cancel path’i aktif.
   - Job API çıktısına `started_at`, `completed_at`, `cancellation_reason` alanları eklendi.
2. **Ciddi güvenlik iyileştirmesi — model allowlist policy**
   - `OPENROUTER_ALLOWED_MODELS` ve model format/uzunluk doğrulaması eklendi.
   - Chat + async jobs endpointleri allowlist dışı modelde `403` dönüyor.
   - Security audit feed’e `api_model_rejected` event tipi eklendi.
3. **Ciddi güvenlik/perf iyileştirmesi — job/idempotency store hardening**
   - Idempotency kayıtlarına TTL eklendi (`RESEARCH_IDEMPOTENCY_TTL_SECONDS`).
   - Tenant başına job store üst sınırı + terminal job prune davranışı eklendi (`RESEARCH_MAX_JOBS_PER_TENANT`).
4. **Runtime propagation**
   - OpenRouter client + web/wiki/financial/openbb/qmd/mcp tool çağrıları signal-aware hale getirildi.

### Verification
- `npm run typecheck` ✅
- `npm test` ✅ (99/99)
- `npm audit --omit=dev --audit-level=high` ✅ (0 vulnerability)
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` ✅ PASS

### Kalan riskler
- Job/idempotency store process-memory; restart sonrası geçmiş kaybolur.
- Allowlist şu an deployment-level; tenant bazlı farklı model policy yönetimi backlog’da.

## Teslim Edilen Ana Bileşenler
1. **Yeni UI Session Endpointi**
   - `POST /ui/session`
   - API key doğrulaması sonrası tenant-scope token üretimi
2. **Auth Middleware Genişletmesi**
   - `/v1/*` artık APP API key + UI session token kabul ediyor
   - Session token tenant mismatch durumunda `403` dönüyor
3. **Frontend Güvenlik Güncellemesi**
   - `chat.js` API key'i localStorage'a yazmıyor
   - session token sadece `sessionStorage` içinde tutuluyor
   - “Oturum Aç” akışı eklendi
4. **Security Utility Katmanı**
   - `service/security/api-key-auth.ts`
   - `service/security/ui-session-store.ts`
5. **Test Genişletmesi**
   - `service/tests/contract/ui.test.ts` session issuance + token auth + tenant-scope testleri

## Verification Özeti
| İddia | Kanıt | Sonuç |
|---|---|---|
| Kod derleniyor | `npm run typecheck` | ✅ |
| Testler geçiyor | `npm test` (**59/59**) | ✅ |
| Güvenlik bağımlılık taraması temiz | `npm audit --omit=dev` | ✅ |
| Teslim kapıları geçildi | `bash scripts/delivery-gate.sh projects/SMART-AI` | ✅ PASS |

## Bilinen Sınırlar
- `/ui/session` için özel brute-force koruması henüz eklenmedi (genel reverse-proxy rate-limit önerilir).
- Session revoke endpoint henüz yok (token TTL ile otomatik kapanır).

## GitHub Senkronizasyonu
- Repo: `https://github.com/kadircicek34/SMART-AI`
- Branch: `main`
- Bu koşum commit + push ile senkronlandı.
## 2026-03-17 Teslim ek paketi (risk closure)
- Kapanan riskler: UI brute-force koruması, session revoke lifecycle, shared MCP health persistence abstraction.
- Üretim notu: `MCP_HEALTH_PERSIST_MODE=http` + `MCP_HEALTH_PERSIST_HTTP_URL` set edilirse çoklu instance ortak health state kullanılabilir.

## 2026-03-17 Teslim ek paketi (cross-repo synthesis)
- `mcporter` + `github-readonly` + `repomix` analizine dayanarak 3 iyileştirme canlıya alındı:
  1) Orchestrator stage checklist,
  2) aşama durum takibi,
  3) memory semantic linking (`related_memory_ids`).
- API etkisi:
  - Chat completion metadata.plan içinde `stages` alanı
  - Memory list/search çıktılarında `related_memory_ids`

## 2026-03-18 Teslim ek paketi (production secret hardening)
### Yapılan ana iyileştirme
- Production runtime için **MASTER_KEY fail-fast** güvenlik kapısı eklendi.
- `NODE_ENV=production` altında `MASTER_KEY_BASE64` eksik/geçersizse servis başlangıçta hata vererek durur; insecure fallback ile ayağa kalkmaz.

### Kod etkisi
- `service/config.ts` güncellendi.
- Yeni regression/security testi eklendi: `service/tests/security/config-master-key.test.ts`.
- Runtime dokümantasyonuna production davranışı notu eklendi: `service/README.md`.

### Verification
- `npm run typecheck` ✅
- `npm test` ✅ (69/69)
- `npm audit --omit=dev` ✅ (0 vuln)
- `delivery-gate` ✅ PASS

### Kalan riskler
- Secret rotation ve merkezi KMS entegrasyonu hâlâ sonraki iterasyon konusu.

## 2026-03-18 Teslim ek paketi (security telemetry + dashboard hardening)
### Yapılan ana geliştirme (yeni özellik)
- **Tenant-scope Security Event Feed** eklendi: `GET /v1/security/events`
  - UI/API auth başarısızlıkları
  - tenant mismatch olayları
  - rate-limit blokları
  - UI origin blokları
  - UI session issue/revoke olayları

### Aynı koşumdaki ciddi güvenlik iyileştirmeleri
1. Dashboard auth akışı session token modeline geçirildi (API key localStorage persistence kaldırıldı).
2. UI state-changing endpointlerinde origin allowlist enforcement eklendi (`UI_ALLOWED_ORIGINS`).
3. `x-tenant-id` format doğrulaması zorunlu hale getirildi.
4. UI HTML yanıtlarına CSP + hardening security header seti eklendi.

### Ürün/operasyon etkisi
- Dashboard üzerinden tenant güvenlik olayları gerçek zamanlı izlenebilir hale geldi.
- Frontend secret handling posture iyileşti.
- Cross-origin kötüye kullanım yüzeyi ve tenant-id manipülasyon riski azaldı.

### Verification
- `npm run typecheck` ✅
- `npm test` ✅ (80/80)
- `npm audit --omit=dev` ✅ (0 vuln)
- `delivery-gate` ✅ PASS

### Kalan riskler
- Security event store şimdilik in-memory; kalıcı SIEM/OTEL export ve merkezi persistence sonraki fazda alınacak.

## 2026-03-19 Teslim ek paketi (OpenBB native tool integration)
### Yapılan ana geliştirme
- SMART-AI tool plane’e **`openbb_search`** eklendi.
  - OpenBB API route’ları üzerinden:
    - `equity/price/quote`
    - `equity/price/historical`
    - `news/company`
    - `news/world`
  - Finans/trading sorgularında tek tool çağrısında market snapshot + trend + haber özeti üretiliyor.

### Orchestrator etkisi
- Planner: trading/OpenBB anahtar sözcüklerinde `openbb_search` route ediyor.
- Thinking loop: OpenBB odaklı sorgular için plan skoru ve aggressive candidate set güncellendi.
- Verifier: trading/market-data sorgularında OpenBB kanıtı zorlaması ve öneri yolu eklendi.
- Deep research: finans sorgularında OpenBB pass (RAG/memory/qmd/mcp/web/wiki ile birlikte) eklendi.

### Konfigürasyon etkisi
- Yeni env/config yüzeyi: `OPENBB_*` parametreleri (`OPENBB_ENABLED`, `OPENBB_API_BASE_URL`, provider/auth/limit ayarları).

### Verification
- `npm run typecheck` ✅
- `npm test` ✅ (85/85)
- `npm audit --omit=dev` ✅ (0 vuln)
- `delivery-gate` ✅ PASS

### Kalan riskler
- OpenBB erişilemezken tool partial-data döndürür; üretimde health-check + retry politikasıyla desteklenmeli.
- OpenBB technical endpoints için henüz data-payload bridge katmanı yok (sonraki iterasyon).

## 2026-03-19 Teslim ek paketi (Async research lifecycle hardening)
### Yapılan ana geliştirme (yeni özellik)
- Async research job hattı production-grade lifecycle seviyesine çıkarıldı:
  - `POST /v1/jobs/research` artık `Idempotency-Key` destekli
  - `GET /v1/jobs` endpointi eklendi (status + limit filtre)
  - `POST /v1/jobs/:jobId/cancel` endpointi eklendi

### Aynı koşumdaki ciddi güvenlik iyileştirmeleri
1. Tenant başına aktif async job limiti eklendi (`RESEARCH_MAX_ACTIVE_JOBS_PER_TENANT`) → job-flood/DoS yüzeyi azaltıldı.
2. Idempotency collision koruması eklendi (aynı key + farklı payload = `409`).
3. `Idempotency-Key` header format/uzunluk validasyonu eklendi.
4. Job error çıktılarında secret/token redaction katmanı eklendi.
5. Security audit feed, research-job event tipleriyle genişletildi.

### Operasyonel etkiler
- Retry ve network kaynaklı duplicate submit’lerde job tekrar çalışmıyor, maliyet ve kuyruk şişmesi azalıyor.
- Ops tarafı artık tenant bazlı job listesini çekip aktif işleri güvenli biçimde cancel edebiliyor.
- Güvenlik paneli/reports, job bazlı suistimal sinyallerini doğrudan görmeye başlıyor.

### Verification
- `npm run typecheck` ✅
- `npm test` ✅ (95/95)
- `npm audit --omit=dev` ✅ (0 vulnerability)
- `npx tsx -e "...smoke create/list/cancel..."` ✅ (`202/200/200`)
- `delivery-gate` ✅ PASS

### Kalan riskler
- Running state’te gerçek runtime interrupt henüz yok; cancel şu an best-effort status transition olarak çalışıyor.
- Job store hâlâ process-memory (restart sonrası lifecycle geçmişi sıfırlanır).

## 2026-03-20 Teslim ek paketi (Security intelligence summary + header abuse hardening)
### Yapılan ana geliştirme (yeni özellik)
- **`GET /v1/security/summary`** endpointi eklendi.
  - Tenant bazlı 24h risk görünümü üretir (`riskScore`, `riskLevel`, `alertFlags`, `topIps`, `byType`).
- Dashboard risk kartı eklendi; artık security panelde olay sayısı yanında risk seviyesi de gösteriliyor.

### Aynı koşumdaki ciddi güvenlik iyileştirmeleri
1. Authorization/Bearer/Tenant header boyut limitleri eklendi, limit aşımı `431` ile güvenli reddediliyor.
2. UI login endpointinde oversized API key payload reddi eklendi (`400`).
3. Security audit detaylarında secret redaction + normalize/sanitize katmanı eklendi.

### Verification
- `npm run typecheck` ✅
- `npm test` ✅ (101/101)
- `npm audit --omit=dev` ✅ (0 vulnerability)
- `PORT=18080 ... npm run dev + curl /health + curl /v1/security/summary` ✅ smoke
- `delivery-gate` ✅ PASS

### Git senkronizasyon durumu
- Commit oluşturuldu: `4162cab` (`feat(security): add risk summary endpoint and header abuse hardening`).
- `git push origin main` denemesi bu koşumda credential eksikliği nedeniyle başarısız oldu (`could not read Username for 'https://github.com'`).

### Kalan riskler
- Security analytics şu an process-memory audit store üzerinde çalışır; restart sonrası geçmiş korunmaz.
- IP reputation / geo intelligence veya SIEM dışa aktarımı henüz yok.
- GitHub push için non-interactive credential (PAT/SSH key) yapılandırılmadıkça otomatik publish tamamlanamaz.
