# SECURITY REPORT — SMART-AI v1.3

## Kapsam
Bu iterasyonda kontrol edilen güvenlik/dayanıklılık yüzeyleri:
- AuthN/AuthZ (`/v1/*` için Bearer API key + UI session token)
- UI auth hardening (`POST /ui/session`, tenant-scope token doğrulaması)
- UI route security (`/ui/*` statik servis)
- Input validation (zod)
- Tool safety (policy allowlist + loop guard)
- MCP resilience + persistence güvenliği
- Dependency güvenliği (`npm audit`)

## Kontrol Sonuçları
| Alan | Durum | Not |
|---|---|---|
| API auth/tenant scope | ✅ | `/v1/*` güvenlik modeli korunuyor |
| UI session auth | ✅ | API key doğrulama + kısa ömürlü token + tenant-scope enforcement |
| Browser-side secret exposure | ✅ | API key localStorage persistence kaldırıldı |
| UI static route security | ✅ | path traversal bloklandı (`isPathInside`) |
| MCP call güvenliği | ✅ | sabit command template + JSON args + adaptive timeout + circuit guard |
| MCP persistence güvenliği | ✅ | snapshot atomik tmp→rename ile yazılıyor |
| Dependencies | ✅ | `npm audit --omit=dev` sonucu 0 vuln |

## Kalan İyileştirme Alanları
1. UI session revoke endpoint + active session sayısı limiti
2. UI için rate-limit / brute-force koruması (`/ui/session`)
3. CSP header hardening + nonce bazlı script policy
4. Memory/RAG encrypt-at-rest data key + KMS

## Sonuç
UI güvenlik modeli güçlendirildi: API key artık kalıcı tarayıcı saklamasında tutulmuyor, `/v1/*` erişimleri tenant-scope kısa ömürlü session token ile sürdürülebiliyor.
## 2026-03-17 Ek güvenlik sertleştirmeleri
- `/ui/session` auth denemeleri için özel anti-bruteforce katmanı uygulandı.
- Auth hata yanıtı normalize edildi (`Invalid credentials`) ve kullanıcı bilgi sızıntısı azaltıldı.
- UI session token revoke lifecycle eklendi (`POST /ui/session/revoke`).
- UI token store içi anahtarlama hashed token ile yapıldı (plaintext token map key kaldırıldı).
- MCP health persistence için shared backend modu eklendi (HTTP endpoint) ve file fallback korundu.

## 2026-03-17 Ek güvenlik notları (cross-repo adaptasyon)
- Stage metadata yalnızca plan izlenebilirliğini artırır; auth boundary veya tool policy bypass etmez.
- Related memory links tamamen tenant-scope içinde hesaplanır (cross-tenant link yok).
- Memory ilişkilendirme token-overlap/Jaccard tabanlıdır; dış kaynaklı otomatik execute akışı içermez.

## 2026-03-18 Güvenlik sertleştirmesi — Master key fail-fast
- `config.ts` içinde production için zorunlu secret doğrulaması eklendi.
- `NODE_ENV=production` iken:
  - `MASTER_KEY_BASE64` yoksa startup error
  - base64 decode sonrası anahtar <32 byte ise startup error
- Dev/test ortamı için deterministic fallback korunarak local developer deneyimi bozulmadı.
- Sonuç: yanlış prod konfigürasyonunda sessiz insecure fallback riski kapatıldı.

## 2026-03-18 Güvenlik sertleştirmesi — UI + tenant boundary + audit feed
- `x-tenant-id` için format doğrulaması eklendi (header injection / path-like tenant id reddi).
- UI state-changing endpointleri için origin allowlist denetimi eklendi (`UI_ALLOWED_ORIGINS`).
- UI static yanıtlarında CSP + hardening header seti aktif edildi:
  - `content-security-policy`
  - `x-frame-options=DENY`
  - `x-content-type-options=nosniff`
  - `referrer-policy=no-referrer`
  - `permissions-policy` + `cross-origin-resource-policy`
- Yeni tenant-scope audit event katmanı eklendi:
  - event tipleri: auth fail, tenant mismatch, rate-limit, ui origin block, session issue/revoke
  - endpoint: `GET /v1/security/events`
- Dashboard auth modeli API key persistence'tan çıkarıldı; kısa ömürlü token ile sessionStorage modeline geçti.

Ek not:
- Audit event store şu an process-memory bounded tutulur; restart sonrası korunmaz. Merkezi persistence/SIEM entegrasyonu sonraki faz için backlog'da tutuldu.

## 2026-03-19 Güvenlik notu — OpenBB native tool entegrasyonu
- `openbb_search` sadece HTTP GET + timeout kontrollü çağrı yapar (`OPENBB_API_TIMEOUT_MS`).
- Auth modeli environment tabanlıdır:
  - `OPENBB_AUTH_TOKEN` (Bearer) veya
  - `OPENBB_USERNAME` + `OPENBB_PASSWORD` (Basic)
- Tool kapama anahtarı eklendi: `OPENBB_ENABLED=false`.
- Varsayılan policy allowlist’e `openbb_search` eklendi; tenant bazlı policy ile kapatılabilir (`TENANT_TOOL_POLICIES_JSON`).
- Risk notu:
  - OpenBB endpoint yanlış/kapalıysa sorgular partial-data ile dönebilir.
  - Basic auth kullanılıyorsa secret yönetimi `.env` yerine secret manager üzerinden yapılmalı.

## 2026-03-19 Güvenlik sertleştirmesi — Async research lifecycle protection
- `POST /v1/jobs/research` için `Idempotency-Key` desteği eklendi.
  - Aynı tenant + aynı key + aynı payload tekrarında job replay-safe şekilde mevcut job döner.
  - Aynı key ile farklı payload denemesi `409` ile engellenir (idempotency collision abuse koruması).
- Tenant başına aktif async job limiti eklendi (`RESEARCH_MAX_ACTIVE_JOBS_PER_TENANT`, varsayılan: 2).
  - Limit aşımlarında `429` dönülür ve security audit event üretilir.
- `Idempotency-Key` header format/uzunluk doğrulaması eklendi.
  - Uygunsuz header’lar `400` ile reddedilir.
- Job failure error mesajları sanitize/redact ediliyor.
  - `sk-*`, `Bearer ...`, `api_key=...` benzeri token pattern’leri response’a açık dönmüyor.
- Security telemetry genişletmesi:
  - Yeni event tipleri: `research_job_queued`, `research_job_cancelled`, `research_job_limit_exceeded`, `research_job_idempotency_reused`, `research_job_rejected`.

Kalan risk:
- Running job cancel şu an "best effort" (status cancel + completion drop). Tool-level gerçek interrupt (AbortSignal chain) sonraki fazda ele alınmalı.

## 2026-03-20 Güvenlik sertleştirmesi — Security risk summary + header abuse guard
- Yeni endpoint: `GET /v1/security/summary`
  - Son pencere için (`window_hours`) tenant-scope risk özeti döner.
  - Çıktı: `riskScore`, `riskLevel`, `alertFlags`, `byType`, `topIps`, `uniqueIps`.
- Security audit log sertleştirmesi:
  - `details` içindeki hassas patternler (`Bearer ...`, `api_key=...`, `sk-...`) otomatik redacted.
  - Kontrol karakterleri ve aşırı uzun alanlar normalize edilip kırpılıyor.
- Header abuse guard:
  - `Authorization`, Bearer token ve `x-tenant-id` için boyut limitleri eklendi.
  - Limit aşımında güvenli şekilde `431` döndürülüyor ve audit event kaydı oluşturuluyor.
- UI auth payload guard:
  - `/ui/session` endpointinde oversized API key payload reddi (`400`) eklendi.

Ek operasyon notu:
- Dashboard artık sadece event sayısı değil, 24 saatlik risk seviyesi + alarm bayraklarını da gösterir.
- Bu iterasyonda SIEM export eklenmedi; summary hesaplaması process-memory audit store üstünden yapılır.

## 2026-03-21 Güvenlik sertleştirmesi — model allowlist + gerçek runtime cancellation
- **Model policy enforcement**
  - `OPENROUTER_ALLOWED_MODELS` allowlist zorunluluğu eklendi (varsayılan: `OPENROUTER_DEFAULT_MODEL`).
  - Model ID için format + max length doğrulaması eklendi.
  - Allowlist dışı veya invalid model denemeleri `api_model_rejected` security event olarak kaydediliyor.
- **Async job runtime hardening**
  - Running job’larda AbortSignal zinciri aktif edildi (LLM + tool çağrıları signal-aware).
  - `RESEARCH_JOB_TIMEOUT_MS` ile zorunlu timeout cancel path’i eklendi.
  - Job API çıktısına `started_at`, `completed_at`, `cancellation_reason` alanları eklendi.
- **Resource abuse mitigation**
  - Idempotency kayıtlarına TTL eklendi (`RESEARCH_IDEMPOTENCY_TTL_SECONDS`).
  - Tenant başına job store upper-bound eklendi (`RESEARCH_MAX_JOBS_PER_TENANT`) ve terminal job prune davranışı uygulandı.

Kalan risk:
- Job/idempotency store hâlâ process-memory; servis restartında geçmiş state korunmuyor.
- Model allowlist şu an deployment-level; tenant bazlı farklı model policy yönetimi sonraki fazda ele alınmalı.

## 2026-03-24 Güvenlik sertleştirmesi — Tenant model policy + fail-closed model boundary
- **Tenant bazlı model boundary enforcement**
  - Yeni endpointler: `GET/PUT/DELETE /v1/model-policy`
  - Tenant artık deployment allowlist içinden daha dar bir model kümesi ve default model tanımlayabiliyor.
  - Chat + async research job endpointleri tenant effective policy dışındaki modelleri `403` ile reddediyor.
- **Fail-closed invalid policy handling**
  - Deployment allowlist değişip tenant policy stale hale gelirse effective allowlist kesişimi hesaplanıyor.
  - Kesişim boşsa tenant policy `invalid` durumuna düşüyor ve istekler güvenli şekilde reddediliyor; sessizce geniş yetkiye dönülmüyor.
- **Policy write hardening**
  - Deployment allowlist dışı model yazılamaz.
  - `defaultModel`, `allowedModels` içinde olmak zorundadır.
  - Tenant başına custom allowlist boyutu sınırlandı (`OPENROUTER_MAX_TENANT_ALLOWED_MODELS`).
- **Security telemetry genişletmesi**
  - Yeni event tipleri: `model_policy_updated`, `model_policy_reset`, `model_policy_change_rejected`
  - Risk scoring artık tekrarlayan policy escape denemelerini `tenant_policy_escape_attempts` flag’i ile işaretleyebiliyor.
- **Browser/UI risk düşürme**
  - Dashboard tenant model policy’yi backend üzerinden yönetir; deployment dışı model seçimi istemci tarafında da görünür şekilde engellenir.
  - Chat UI, tenant default modeli otomatik seçerek yanlış/boş model seçiminden kaynaklı operatör hatasını azaltır.

Kalan risk:
- Tenant model policy store şu an dosya tabanlı; multi-instance/shared ortamda Redis/Postgres gibi merkezi store daha doğru olacaktır.
- Policy değişiklikleri için RBAC/approval workflow henüz yok; mevcut güvenlik sınırı tenant auth + deployment allowlist validasyonudur.
- Host npm kurulumu kırık olduğu için bu koşumda `npm audit` çalıştırılamadı; dependency taraması host toolchain düzeltilince tekrar edilmeli.

## 2026-03-22 Güvenlik sertleştirmesi — UI session lifecycle defense-in-depth
- **Session rotation + introspection**
  - `GET /ui/session`: aktif token için expiry/idle penceresi görünürlüğü
  - `POST /ui/session/refresh`: token rotate; eski token anında invalid
- **Idle timeout enforcement**
  - Yeni env: `UI_SESSION_MAX_IDLE_SECONDS`
  - Auth middleware session resolve akışında idle-expired tokenları otomatik düşürür
- **User-Agent fingerprint binding**
  - Session issue sırasında UA hash tutulur
  - Farklı UA ile kullanılan tokenlar `user_agent_mismatch` ile reddedilip revoke edilir
- **Session store abuse mitigation**
  - Tenant/global session cap eklendi:
    - `UI_SESSION_MAX_SESSIONS_PER_TENANT`
    - `UI_SESSION_MAX_SESSIONS_GLOBAL`
  - Cap aşımında en eski tokenların otomatik evict edilmesiyle memory growth kontrol altına alındı
- **Security telemetry genişletmesi**
  - Yeni event tipleri: `ui_session_rotated`, `ui_session_validation_failed`, `ui_session_refresh_failed`
  - Risk summary scoring/flag mekanizması session token abuse sinyallerini içerecek şekilde güncellendi

Kalan risk:
- Session store process-memory tabanlı olduğu için restart sonrası aktif sessionlar düşer (security açısından fail-safe, UX açısından re-login gerektirir).
- User-Agent binding tek başına güçlü cihaz kimliği değildir; ileri fazda çoklu sinyal fingerprint + adaptive risk policy önerilir.
