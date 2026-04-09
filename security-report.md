# SECURITY REPORT — SMART-AI v1.21

## 2026-04-09 Güvenlik sertleştirmesi — tenant-scoped operator roster / RBAC control plane

### Bu koşumda kapatılan riskler
1. **Geniş admin recovery yüzeyi daraltıldı:** Incident acknowledge, clear-request ve clear approval adımları artık action bazlı explicit roster ile kontrol edilebiliyor.
2. **Least-privilege eksikliği kapatıldı:** Incident commander, recovery requester ve recovery approver rolleri tenant bazında ayrıldı; `roster_required` modunda ayrı rol atanmayan admin aksiyonları fail-closed reddediliyor.
3. **Denied recovery denemeleri görünür oldu:** Yetkisiz operator aksiyonları `security_export_operator_action_denied` audit event'i ile kaydediliyor.
4. **Unsafe config drift daraltıldı:** Deployment default roster env'leri, principal üst sınırı ve input validation ile yanlış/eksik operator policy girdileri persisted olmadan bloklanıyor.

### Kontroller
- Contract testler operator policy CRUD, validation, read-only deny ve incident workflow enforcement senaryolarını doğruladı.
- Unit testler operator authorization karar mantığını (`open_admins`, `roster_required`, role match/mismatch) doğruladı.
- `npm audit --omit=dev` sonucu: `0 vulnerability`.

### Kalan riskler
- Operator roster bugün principal-name listesi seviyesinde; external IdP/group sync ve merkezi directory entegrasyonu henüz yok.
- Operator policy store hâlâ local file tabanlı; multi-instance shared backend ihtiyacı sürüyor.
- Break-glass / JIT delegated approval modeli henüz yok.

## 2026-04-08 Güvenlik sertleştirmesi — canary-backed clear request + four-eyes incident reopen

### Bu koşumda kapatılan riskler
1. **Tek operatör reopen riski kapatıldı:** Incident clear artık pending clear request + ikinci operatör onayı gerektiriyor.
2. **Kör reopen riski kapatıldı:** Clear request yalnızca canlı canary delivery 2xx kabul edilirse oluşuyor.
3. **Stale recovery riski daraltıldı:** Clear request TTL ile sınırlı, requester kendi talebini approve edemiyor ve stale policy/canary durumunda clear fail-closed reddediliyor.
4. **Recovery target sızıntısı engellendi:** Canary için gereken raw destination URL, API/receipt yüzeyine çıkmadan encrypted internal target material olarak saklanıyor.

### Kontroller
- Contract testler ile second-operator enforcement, duplicate pending request reject ve expired clear request reject doğrulandı.
- `npm audit --omit=dev` sonucu: `0 vulnerability`.

### Kalan riskler
- Four-eyes enforcement bugün principal-name seviyesinde; tenant içi ayrı approver directory/RBAC henüz yok.
- Incident/persistence store hâlâ local file tabanlı; multi-instance shared backend gereksinimi sürüyor.

## 2026-04-07 Güvenlik sertleştirmesi — delivery incident ack + manual clear control plane
- **Incident lifecycle control plane**
  - Yeni endpointler: `GET /v1/security/export/delivery-incidents`, `POST /v1/security/export/delivery-incidents/:incidentId/acknowledge`, `POST /v1/security/export/delivery-incidents/:incidentId/clear`
  - Incident kayıtları artık revision, ack owner, clear-after, resolved metadata ve redacted destination fingerprint ile tutuluyor.
  - Dashboard security delivery incidents tablosu ack/clear aksiyonlarını doğrudan bu kontrol düzlemine bağlıyor.
- **Fail-open quarantine kapanışı (ciddi iyileştirme #1)**
  - Quarantine artık sadece süre tabanlı otomatik kalkmıyor; active incident açık kaldığı sürece preview/sync/async/redrive akışları fail-closed bloklu.
  - Böylece cooldown süresi dolduğu anda operatör onayı olmadan riskli destination’ın tekrar açılma penceresi kapatıldı.
- **Optimistic concurrency + zorunlu açıklama (ciddi iyileştirme #2)**
  - Ack/clear endpointleri `revision` alanı ile stale panel verilerini reddediyor (`409 incident_state_conflict`).
  - Ack/clear notları zorunlu ve sanitize edilerek audit kaydına yazılıyor; operasyonel karar izi zorunlu hale geldi.
- **Ack reset on new failure (ciddi iyileştirme #3)**
  - Acknowledged incident için yeni terminal failure/dead-letter geldiğinde önceki ack otomatik sıfırlanıyor.
  - Eski bir operatör onayının yeni bir arıza dalgasını yanlışlıkla meşrulaştırma riski kaldırıldı.
- **Telemetry genişletmesi**
  - Yeni audit event tipleri: `security_export_delivery_incident_opened`, `security_export_delivery_incident_acknowledged`, `security_export_delivery_incident_cleared`.
  - Security event feed üzerinden incident lifecycle baştan sona izlenebilir hale geldi.
- **Dependency posture**
  - `npm audit --omit=dev` tekrar temiz geçti (0 vulnerability).

Kalan risk:
- Incident/quarantine state hâlâ local delivery store içinde tutuluyor; multi-instance HA için shared incident backend gerekli.
- Clear akışı tek operatör onayıyla çalışıyor; çift-onay/canary delivery sonrası clear politikası henüz yok.
- Export delivery için merkezi egress proxy / VPC-level outbound enforcement hâlâ backlog’da.

## 2026-04-06 Güvenlik sertleştirmesi — delivery analytics + automatic destination quarantine
- **Delivery analytics control plane**
  - Yeni endpoint: `GET /v1/security/export/delivery-analytics`
  - Son pencere için success-rate, status dağılımı, quarantined/degraded destination sayısı ve timeline bucket’ları dönülüyor.
  - Dashboard delivery paneli analytics summary + incident tablosu ile riskli destination’ları görünür kılıyor.
- **Automatic destination quarantine**
  - Aynı tenant içindeki aynı destination son pencere içinde tekrarlayan terminal failure veya dead-letter üretirse otomatik quarantine durumuna alınıyor.
  - Preview, sync delivery, async enqueue ve manual redrive akışları quarantine durumunda fail-closed bloke ediyor.
  - Bloklanan receipt’lerde açık `destination_quarantined` failure code saklanıyor; query/path secret’ları yine redacted kalıyor.
- **Async enqueue/redrive hardening**
  - Async enqueue path’i target resolution/quarantine hatalarını artık kontrollü `blocked` receipt + `403` ile döndürüyor; belirsiz 500 sınıfı hata penceresi kapatıldı.
  - Manual redrive da aynı health/quarantine guard’ını gördüğü için bozuk hedefe tekrar tekrar replay yapılamıyor.
- **Signing contract isolation fix**
  - Signing registry için test reset helper eklendi; security-events contract suite içindeki global singleton state leakage temizlendi.
  - Bu sayede signing lifecycle + delivery güvenlik regresyonları tekrar deterministik hale geldi.
- **Dependency posture**
  - `npm audit --omit=dev` tekrar temiz geçti (0 vulnerability).

Kalan risk:
- Delivery incident/quarantine state hâlâ local delivery kayıtlarından türetiliyor; shared backend veya merkezi incident store henüz yok.
- Quarantine clear/ack için ayrı operatör onay workflow’u henüz yok; soğuma penceresi süre tabanlı.
- Export delivery için merkezi egress proxy / VPC-level outbound enforcement hâlâ backlog’da.


## Kapsam
Bu iterasyonda kontrol edilen güvenlik/dayanıklılık yüzeyleri:
- AuthN/AuthZ (`/v1/*` için Bearer API key + UI session token)
- UI auth hardening (`POST /ui/session`, tenant-scope token doğrulaması)
- UI route security (`/ui/*` statik servis)
- Input validation (zod)
- Tool safety (policy allowlist + loop guard)
- MCP resilience + persistence güvenliği
- Dependency güvenliği (`npm audit`)
- Security export egress güvenliği (webhook/SIEM delivery)

## Kontrol Sonuçları
| Alan | Durum | Not |
|---|---|---|
| API auth/tenant scope | ✅ | `/v1/*` güvenlik modeli korunuyor |
| UI session auth | ✅ | API key doğrulama + kısa ömürlü token + tenant-scope enforcement |
| Browser-side secret exposure | ✅ | API key localStorage persistence kaldırıldı |
| UI static route security | ✅ | path traversal bloklandı (`isPathInside`) |
| MCP call güvenliği | ✅ | sabit command template + JSON args + adaptive timeout + circuit guard |
| MCP persistence güvenliği | ✅ | snapshot atomik tmp→rename ile yazılıyor |
| Security export delivery egress | ✅ | dedicated delivery-egress policy + host/path allowlist + HTTPS-only + DNS pinning + Ed25519 signature + redacted receipts |
| Dependencies | ✅ | `npm audit --omit=dev` sonucu 0 vuln |

## 2026-04-05 Güvenlik sertleştirmesi — signing maintenance control plane + shared-store coordination
- **Manual maintenance control plane**
  - Yeni endpointler: `GET /v1/security/export/signing-maintenance`, `POST /v1/security/export/signing-maintenance/run`
  - Admin operatör maintenance dry-run ile rotate/prune aksiyonlarını önceden görebiliyor; execute akışı audit event olarak kayda geçiyor (`security_export_signing_maintenance_run`).
  - Dashboard signing paneli leader lease, revision, son koşum özeti ve history tablosu gösteriyor.
- **Shared-store refresh hardening**
  - Signing registry kritik read/sign/mutate akışlarından önce store dosyasını yeniden yükleyerek stale active key kullanımını azaltıyor.
  - Aynı store'u paylaşan çoklu instance'lar rotate sonrası güncel active key'e hizalanıyor; follower instance eski memory snapshot'ıyla imza üretmiyor.
- **Leader lease ile tek-yazarlı maintenance**
  - Auto-rotate/prune mutasyonları lease tabanlı koordinasyonla tek lider instance tarafından diske yazılıyor.
  - Bu sayede multi-instance shared-file kurulumlarında duplicate rotate/prune ve state overwrite riski daraltıldı.
- **Sync persistence guard**
  - Signing lifecycle mutasyonları atomic sync persistence ile diske yazılıyor; rotate sonrası crash/restart penceresinde memory-only drift riski azaltıldı.
- **Dependency posture**
  - `npm audit --omit=dev` tekrar temiz geçti (0 vulnerability).

Kalan risk:
- Delivery queue/audit/policy/session persistence hâlâ local file tabanlı; gerçek shared backend gerekecek.
- Lease tabanlı koordinasyon shared-file senaryosunu iyileştirir ama network-partition tolerant distributed lock değildir; tam HA için merkezi coordination/backend gerekir.
- Export delivery için merkezi egress proxy / VPC-level outbound enforcement henüz yok.

## 2026-04-04 Güvenlik sertleştirmesi — signing lifecycle policy + auto-rotation guard
- **Lifecycle policy control plane**
  - Yeni endpointler: `GET /v1/security/export/signing-policy`, `PUT /v1/security/export/signing-policy`
  - Dashboard signing paneli artık auto-rotate, rotate-after, expire-after, warn-before ve verify-retention eşiklerini yönetebiliyor.
  - `/v1/security/export/keys` ve `/v1/security/summary` signing lifecycle health + alert durumunu expose ediyor.
- **Auto-rotation + fail-closed expiry guard**
  - Active signing key rotate window'unu geçtiğinde export/delivery öncesi auto-rotation tetiklenebiliyor.
  - Auto-rotation kapalıysa expired active key ile imzalama `503` fail-closed reddediliyor; operatöre lifecycle state geri dönüyor.
  - Manual rotate ve policy update aksiyonları audit log’a yazılıyor (`security_export_signing_rotated`, `security_export_signing_policy_updated`).
- **JWKS surface minimization**
  - Verify-only anahtarlar artık retention süresi dolunca prune ediliyor; public JWKS yalnızca geçerli active + retention içindeki verify-only anahtarları yayınlıyor.
  - Bu sayede gereksiz uzun key exposure azaltıldı ve key hygiene posture’u güçlendi.
- **Operational visibility**
  - Dashboard signing tablosu rotate-due / expiring / expired / prune işaretleri gösteriyor.
  - Health status ve alerts aynı control plane üzerinde operatöre sunuluyor.
- **Dependency posture**
  - `npm audit --omit=dev` tekrar temiz geçti (0 vulnerability).

Kalan risk:
- Delivery queue/audit/policy/session store hâlâ local file tabanlı; multi-instance shared backend gerekecek.
- Signing lifecycle maintenance şu an process-local timer + request-path tetikleme ile çalışıyor; multi-instance ortamda distributed coordination yok.
- Export delivery için merkezi egress proxy / VPC-level outbound enforcement henüz yok.

## 2026-04-03 Güvenlik sertleştirmesi — delivery egress policy plane + target preview
- **Dedicated delivery-egress control plane**
  - Yeni endpointler: `GET/PUT/DELETE /v1/security/export/delivery-policy`
  - Security export delivery allowlist’i artık remote source policy’den bağımsız tenant/deployment policy ile yönetiliyor.
  - `inherit_remote_policy`, `allowlist_only`, `disabled` modları ile migration + fail-closed operasyon yüzeyi sağlandı.
- **Host + path-prefix enforcement**
  - Delivery allowlist host seviyesinden `host + path-prefix` kuralı seviyesine indi.
  - Aynı host üzerindeki yanlış webhook path’lerine giden teslimler fail-closed bloke ediliyor.
  - Rule formatı `siem.example.com/hooks`, `https://logs.example.com/v1/tenants/tenant-a`, `*.ops.example.com/audit` gibi minimize edilmiş least-privilege ifadeleri destekliyor.
- **Preflight target preview**
  - Yeni endpoint: `POST /v1/security/export/deliveries/preview`
  - Operatör gerçek gönderim yapmadan `allowed`, `reason`, `matched_rule`, `pinned_address` verdict’ini görebiliyor.
  - Path/query secret’ları preview sonucunda redacted fingerprint seviyesinde tutuluyor.
- **Telemetry / audit güçlendirmesi**
  - Yeni audit event tipleri: `security_export_delivery_previewed`, `security_export_delivery_policy_updated`, `security_export_delivery_policy_reset`
  - Delivery policy değişiklikleri ve preview verdict’leri olay izi bırakıyor; incident-response görünürlüğü artıyor.
- **Dashboard operator hardening**
  - `/ui/dashboard` delivery policy paneli + preview aksiyonu eklendi.
  - Admin olmayan oturumlar için delivery policy ve preview yüzeyi salt-okunur/disabled kalıyor.
- **Dependency posture**
  - `npm audit --omit=dev` tekrar temiz geçti (0 vulnerability).

Kalan risk:
- Delivery queue/audit/policy/session store hâlâ local file tabanlı; multi-instance shared backend gerekecek.
- Signing key rotation hâlâ admin tetiklemeli; otomatik expiry/rotation scheduler + alerting henüz yok.
- Deployment default delivery policy backward-compatible migration için `inherit_remote_policy` kalabilir; daha sert secure-by-default posture isteyen kurulumlar explicit `allowlist_only` kullanmalı.

## 2026-04-02 Güvenlik sertleştirmesi — dead-letter redrive + anti-rebinding pinning
- **Dead-letter recovery control plane**
  - Yeni endpoint: `POST /v1/security/export/deliveries/:deliveryId/redrive`
  - Dashboard delivery tablosu dead-letter item için tek tık manual redrive başlatabiliyor.
  - Yeni audit event tipi: `security_export_delivery_redriven`
- **Bounded replay / redrive guard**
  - Yeni env: `SECURITY_EXPORT_DELIVERY_MAX_MANUAL_REDRIVES`
  - Aynı dead-letter item için sınırsız manual replay kapatıldı; limit aşımlarında fail-closed `429` dönüyor.
- **Retry material fingerprint hardening**
  - Retry/redrive materyali artık `origin`, `host`, `path_hash`, `matched_host_rule` fingerprint’iyle saklanıyor.
  - Fingerprint mismatch durumunda queue tampering/replay denemesi fail-closed dead-letter’a düşüyor.
- **Remote RAG anti-rebinding closure**
  - URL preview/ingest requestleri artık preflight public DNS resolve sonrası aynı pinned IP ile bağlanıyor.
  - Redirect zinciri manuel izlenmeye devam ederken lookup→connect arası DNS rebinding penceresi daraltıldı.
- **Dependency posture**
  - `npm audit --omit=dev --audit-level=high` tekrar temiz geçti (0 vulnerability).

Kalan risk:
- Delivery queue/audit/policy/session store hâlâ local file tabanlı; multi-instance shared backend gerekecek.
- Signing key rotation hâlâ admin tetiklemeli; otomatik expiry/rotation policy henüz yok.
- Export egress policy şu an remote source allowlist ile paylaşılıyor; ayrı delivery-egress plane sonraki fazda değerlendirilebilir.

## 2026-04-01 Güvenlik sertleştirmesi — asymmetric security export signing registry
- **Asymmetric signing upgrade**
  - `GET /v1/security/export` artık hash-chain export bundle'ını Ed25519 detached signature ile döndürüyor.
  - `POST /v1/security/export/verify` signed bundle geldiğinde chain integrity + signature doğrulamasını birlikte yapıyor.
  - Delivery headers symmetric HMAC yerine Ed25519 + key-id metadata ile üretiliyor.
- **Signing key lifecycle / rotation**
  - Yeni endpointler: `GET /v1/security/export/keys`, `POST /v1/security/export/keys/rotate`, `GET /.well-known/smart-ai/security-export-keys.json`
  - Active key rotate edildiğinde önceki key verify-only durumda tutuluyor; eski export/delivery kanıtları doğrulanabilir kalıyor.
  - Public JWKS discovery, üçüncü taraf verifier/SIEM tarafında shared secret taşımadan doğrulama sağlıyor.
- **Private key at-rest koruması**
  - Signing private key materyali plaintext store edilmez; AES-256-GCM ile encrypted-at-rest tutulur.
  - Yeni unit test, persisted store içinde raw private JWK `d` alanının yer almadığını doğrular.
- **Control plane görünürlüğü**
  - Dashboard signing key özeti, key tablosu ve rotate aksiyonu eklenerek operasyonel görünürlük artırıldı.

Kalan risk:
- Dead-letter item’ları için ayrı manual redrive endpointi henüz yok.
- Remote URL fetch hattında lookup→connect tam anti-rebinding pinning henüz yok.
- Delivery queue ve audit/policy/session store hâlâ local file tabanlı; multi-instance shared backend gerekecek.

## 2026-03-31 Güvenlik sertleştirmesi — resilient security export delivery queue
- **Async resilient delivery mode**
  - `POST /v1/security/export/deliveries` artık `mode=async` ile queued/retrying/dead-letter lifecycle’ı destekliyor.
  - Retryable HTTP (`408/425/429/5xx`) ve network hataları transient kabul edilip backoff ile tekrar deneniyor.
- **Encrypted retry payload store**
  - Retry queue materyali düz JSON tutulmuyor; AES-256-GCM ile encrypted-at-rest saklanıyor.
  - Delivery receipt geçmişi yalnızca redacted metadata içeriyor; export bundle plaintext’i receipt store yüzeyine sızmıyor.
- **Replay / duplicate delivery guard**
  - `Idempotency-Key` desteği async delivery için eklendi.
  - Aynı key + farklı payload `409` ile reddediliyor; aynı payload replay’i mevcut receipt’i reuse ediyor.
  - Tenant başına aktif async delivery üst sınırı ile queue flood / egress abuse riski sınırlandı.
- **Dead-letter telemetry**
  - Yeni event tipi: `security_export_delivery_dead_lettered`
  - Risk summary artık dead-letter oluşumunu ayrıca yükseltebiliyor (`security_export_dead_letters_present`).
- **Ops surface hardening**
  - Dashboard sync/async seçimi yapabiliyor; attempt count / next attempt / dead-letter durumları görünür.
  - `GET /v1/security/export/deliveries?status=...` ile queue durumu API’den filtrelenebiliyor.

Kalan risk:
- Dead-letter item’ları için ayrı manual redrive endpointi henüz yok; operatör yeni delivery isteğiyle tekrar başlatıyor.
- Delivery queue ve audit/policy store hâlâ local file tabanlı; multi-instance shared backend gerekecek.
- HMAC imza symmetric modelde; bağımsız üçüncü taraf verifier için asymmetric signing + key registry backlog’da.

## 2026-03-30 Güvenlik sertleştirmesi — tamper-evident security export delivery
- **Allowlist-controlled outbound delivery**
  - Yeni endpointler: `GET/POST /v1/security/export/deliveries`
  - Delivery yalnızca tenant remote policy `allowed_hosts` eşleşmesi olan hedeflerde açılıyor.
  - Embedded credential içeren veya allowlist dışı host/port kullanan URL’ler bloklanıyor.
- **DNS pinning + public egress enforcement**
  - Hedef hostname public DNS ile resolve ediliyor ve request pinned address üzerinden gönderiliyor.
  - Private/local/reserved IP alanlarına egress fail-closed reddediliyor.
  - Varsayılan allowed port yüzeyi `443` ile sınırlı.
- **Tamper-evident delivery headers**
  - `content-digest`, `x-smart-ai-signature`, `x-smart-ai-signature-input`, `x-smart-ai-delivery-id`, `x-smart-ai-head-chain-hash` header’ları eklendi.
  - İmza tenant-scoped master-key türevi ile üretildi; body hash + timestamp + nonce metadata’sı taşınıyor.
- **Receipt redaction + audit telemetry**
  - Delivery geçmişi path/query secret’larını saklamıyor; sadece redacted origin/host/path-hash metadata tutuluyor.
  - Yeni event tipleri: `security_export_delivered`, `security_export_delivery_failed`, `security_export_delivery_blocked`.
  - Risk summary artık `security_export_egress_policy_violations` ve `security_export_delivery_instability` sinyallerini yükseltebilir.
- **Operator UX**
  - Dashboard’a recent delivery tablosu ve webhook push paneli eklendi.
  - Read-only credential’lar bu admin yüzeye erişemiyor.

Kalan risk:
- Delivery retry queue / dead-letter mekanizması henüz yok; başarısız upstream çağrılar manual retry gerektiriyor.
- HMAC imza symmetric model kullanıyor; üçüncü taraf bağımsız doğrulama için asymmetric signing / key registry backlog’da.
- Delivery allowlist şu an remote source allowlist ile paylaşılıyor; ileride ayrı bir egress policy plane düşünülebilir.

## 2026-03-29 Güvenlik sertleştirmesi — tamper-evident security export
- **Tamper-evident audit chain**
  - Security audit eventleri artık `sequence`, `prev_chain_hash`, `chain_hash` alanlarıyla zincirleniyor.
  - Persisted audit snapshot’lar geriye uyumlu biçimde rehydrate edilip hash-chain’e yükseltiliyor.
- **Admin-scope evidence export**
  - Yeni endpoint: `GET /v1/security/export`
  - Export bundle, bounded window/limit ile döner; sınırsız audit dump yüzeyi açılmaz.
  - Export yüzeyi `tenant:admin` ile korunur; read-only credential yalnızca summary görebilir.
- **Transfer sonrası bütünlük doğrulaması**
  - Yeni endpoint: `POST /v1/security/export/verify`
  - Dış sisteme taşınan audit paketi tekrar gönderildiğinde chain hash mismatch deterministik biçimde yakalanır.
- **Ops visibility hardening**
  - `GET /v1/security/summary` artık gerçek risk + integrity telemetry döner.
  - Dashboard risk kartı summary verisiyle güncellendi; admin kullanıcı için tek tık export akışı eklendi.
- **Dependency posture**
  - `npm audit --omit=dev` tekrar temiz geçti (0 vulnerability).

Kalan risk:
- Export hattı şu an pull-based; SIEM/webhook push delivery henüz yok.
- Hash-chain doğrulaması server-side yapılır; dış sistem için public-key dağıtımlı bağımsız doğrulama gelecekte değerlendirilebilir.
- Audit/session/policy persistence hâlâ local file tabanlı; shared backend backlog’da.

## 2026-03-28 Güvenlik sertleştirmesi — tenant remote source policy governance
- **Secure-by-default remote ingest governance**
  - Deployment varsayılanı `preview_only` yapıldı; explicit tenant policy olmadan remote URL ingest kapalı.
  - `GET/PUT/DELETE /v1/rag/remote-policy` admin gate arkasında çalışıyor.
- **Allowlist sertleştirmesi**
  - Exact public host/IP ve `*.example.com` wildcard kuralları destekleniyor.
  - Unicode host girişleri punycode normalize ediliyor; private/local host ve private IP allowlist girdileri fail-closed reddediliyor.
  - Preview ile ingest yetkisi ayrı gözlemlenebiliyor (`allowed_for_preview`, `allowed_for_ingest`, `matched_host_rule`).
- **Telemetry + risk scoring**
  - Yeni event tipleri: `rag_remote_policy_denied`, `rag_remote_policy_updated`, `rag_remote_policy_reset`.
  - Tekrarlayan deny sinyalleri `remote_fetch_policy_violations` risk bayrağına dahil edildi.
- **Ops surface hardening**
  - Dashboard’a remote source policy paneli eklendi; read-only credential’lar salt-okunur kalıyor.
  - RAG belge metriği doğru veri kaynağıyla düzeltildi.

Kalan risk:
- `allowlist_only` modunda preview hâlâ public-safe fetch yapabiliyor; daha sert egress governance için preview’ı da allowlist’e bağlayan opsiyonel mod sonraki fazda düşünülebilir.
- Lookup→connect arası DNS pinning hâlâ yok; anti-rebinding derinleştirmesi backlog’da.
- Policy event export/SIEM pipeline henüz yok.

## 2026-03-27 Güvenlik sertleştirmesi — secure remote RAG URL ingest
- **SSRF / private-network koruması**
  - Remote URL ingest ve preview akışları artık localhost, RFC1918, link-local, CGNAT, reserved IP aralıklarını fail-closed şekilde reddediyor.
  - Credential gömülü URL’ler (`https://user:pass@...`) ve allowlist dışı portlar engelleniyor.
- **Redirect güvenliği**
  - Her redirect hop’u yeniden validate ediliyor.
  - Redirect loop, missing location ve unsafe redirect target senaryoları bloklanıyor.
- **Payload abuse guard**
  - `RAG_REMOTE_FETCH_TIMEOUT_MS`, `RAG_REMOTE_FETCH_MAX_BYTES`, `RAG_REMOTE_FETCH_MAX_REDIRECTS`, `RAG_REMOTE_ALLOWED_PORTS`, `RAG_REMOTE_ALLOWED_CONTENT_TYPES` ile remote fetch policy explicit hale getirildi.
  - Binary/disallowed MIME yanıtları ve oversized body’ler ingest öncesi reddediliyor.
- **Yeni operator-facing güvenli özellik**
  - `POST /v1/rag/url-preview` ile ingest öncesi kontrollü metadata/snippet preview alınabiliyor.
- **Security telemetry genişletmesi**
  - Yeni event tipleri: `rag_remote_url_blocked`, `rag_remote_url_fetch_failed`, `rag_remote_url_previewed`, `rag_remote_url_ingested`
  - Tekrarlayan blocked fetch denemeleri risk summary scoring’ine dahil edildi.

Kalan risk:
- DNS lookup ile gerçek TCP connect arasında tam pinning yapılmıyor; daha sert anti-rebinding için custom dispatcher/egress control katmanı sonraki fazda değerlendirilmeli.
- Domain allowlist/approval workflow henüz tenant bazlı yönetilmiyor.

## 2026-03-26 Güvenlik sertleştirmesi — persistent session/audit state + dependency patch
- **UI session persistence hardening**
  - `UI_SESSION_STORE_FILE` ile hashed session metadata file-backed saklanıyor.
  - Plaintext session token diskte tutulmuyor; yalnızca hash + metadata restore ediliyor.
  - `GET /v1/ui/sessions`, `POST /v1/ui/sessions/:sessionId/revoke`, `POST /v1/ui/sessions/revoke-all` admin gate altında çalışıyor.
- **Audit evidence persistence**
  - `SECURITY_AUDIT_STORE_FILE` ile sanitize edilmiş audit eventler restart sonrası korunuyor.
  - Bounded retention korunuyor; event detayları yeniden sanitize edilerek hydrate ediliyor.
- **Incident-response UX**
  - Dashboard'a aktif session görünürlüğü ve “Diğer Oturumları Kapat” aksiyonu eklendi.
  - `exceptCurrent=true` akışı mevcut operatör session’ını düşürmeden bulk revoke yapabiliyor.
- **Dependency advisory closure**
  - `fastify` güvenli sürüme yükseltildi; `npm audit --omit=dev` tekrar 0 vulnerability döndü.

Kalan risk:
- Session/audit persistence tek instance local disk üzerinde; multi-instance dağıtımda shared backend gerekecek.
- Session kontrol yüzeyi tenant içi kullanıcı/RBAC ayrımına henüz sahip değil; mevcut sınır tenant admin scope.

## Kalan İyileştirme Alanları
1. UI session ve audit store'u Redis/Postgres gibi shared persistence backend'ine taşı
2. Tenant içi kullanıcı bazlı session ownership / RBAC / approval workflow ekle
3. CSP nonce/strict-dynamic ve daha ileri browser isolation politikaları ekle
4. Memory/RAG encrypt-at-rest data key + KMS entegrasyonu

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

## 2026-03-25 Güvenlik sertleştirmesi — Scoped authZ + UI session origin binding
- **Least-privilege credential modeli**
  - Yeni env yüzeyi: `APP_API_KEY_DEFINITIONS`
  - Scope hiyerarşisi: `tenant:read` → `tenant:operate` → `tenant:admin`
  - Legacy `APP_API_KEYS` backward-compatible olarak full admin davranışını korur.
- **Hassas yönetim yüzeylerinde admin gate**
  - `GET/POST/DELETE /v1/keys/openrouter*`
  - `PUT/DELETE /v1/model-policy`
  - `POST /v1/mcp/reset`
  - `POST /v1/mcp/flush`
  - Yetkisiz denemeler `api_scope_denied` security event’i üretir.
- **UI session privilege inheritance**
  - `/ui/session` ile açılan token artık principal adı + scope setini taşır.
  - `/ui/session/refresh` rotation akışında bu privilege set korunur; read-only token UI üzerinden admin’e yükselemez.
- **Origin-bound unsafe API writes**
  - UI session token ile yapılan state-changing `/v1/*` çağrıları allowlisted Origin’e bağlandı.
  - Eksik veya kötü origin 403 + audit event ile reddedilir.
- **Security analytics genişletmesi**
  - Risk summary scoring artık tekrar eden scope probing denemelerini `privilege_escalation_attempts` bayrağı ile yükseltebilir.

Kalan risk:
- API key tanımları hâlâ env tabanlı; büyük ölçekli prod kurulumda secret manager/DB-backed registry daha doğru olacaktır.
- UI session ve audit store process-memory tabanlı; multi-instance ortamda merkezi persistence gerekecek.
