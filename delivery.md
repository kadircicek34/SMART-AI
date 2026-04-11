# DELIVERY — SMART-AI v1.23 (Two-Person Delegation Approval + Fresh Session Step-Up)

## 2026-04-11 Teslim Özeti

### Yapılanlar
- Security export delegation issuance akışı `pending_approval -> active` yaşam döngüsüne yükseltildi; yeni `POST /v1/security/export/operator-delegations/:grantId/approve` endpoint'i eklendi.
- Delegation store yeni status ve metadata alanlarıyla sertleştirildi: `pending_approval`, `approval_expired`, `requested_by`, `requested_at`, `approved_by`, `approved_at`, `approval_expires_at`, `approval_note`.
- Create/approve/revoke delegation mutasyonlarına fresh-session step-up eklendi; taze olmayan dashboard oturumları fail-closed `403 permission_error` alıyor, API key admin akışı korunuyor.
- Dashboard delegation paneli pending approval görünürlüğü, approve/revoke aksiyonları, requester/approver bilgisi ve step-up açıklamasıyla güncellendi.
- Audit ve test yüzeyi production-grade hale getirildi: `security_export_operator_delegation_requested` audit event’i, focused contract/unit testler ve delegated recovery workflow kanıtı eklendi.

### Doğrulama
- `npm run typecheck` → PASS
- `npx tsx --test tests/security/export-operator-delegation.test.ts tests/contract/security-export-operator-delegations.test.ts` → PASS (4/4)
- `npm test` → PASS (201/201)
- `npm audit --omit=dev` → PASS (0 vulnerability)
- Smoke (`/health`, `GET /v1/security/export/operator-delegations?status=pending_approval`, `/ui/dashboard`) → PASS
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` → PASS

### Kalan riskler
- Delegation ve operator roster bugün principal-name listesi seviyesinde; external IdP/group sync henüz yok.
- Step-up doğrulaması şu an UI session tazeliği + API key modeline dayanıyor; WebAuthn/IdP re-auth entegrasyonu henüz yok.
- Delegation, incident, operator policy, audit ve session state hâlâ local file tabanlı; shared backend / multi-instance HA ihtiyacı sürüyor.

## 2026-04-10 Teslim Özeti

### Yapılanlar
- Security export recovery hattına yeni `POST/GET /v1/security/export/operator-delegations` ve `POST /v1/security/export/operator-delegations/:grantId/revoke` control plane'i eklendi.
- Incident workflow içindeki `acknowledge`, `clear-request` ve `clear` authorization zinciri, roster yetkisi yoksa aktif delegation grant ile ilerleyecek şekilde genişletildi.
- Delegation grant'leri tenant/incident/action/delegated-operator/TTL scope'u, self-delegation reject ve tek kullanımlık consume modeli ile sertleştirildi.
- Dashboard delegation tablosu, revoke aksiyonu, README/env dokümantasyonu ve audit telemetry production-grade break-glass görünürlüğüyle güncellendi.
- Delegation create error handling fail-closed `404` + `invalid_request_error` ayrımıyla sertleştirildi.

### Doğrulama
- `npm run typecheck` → PASS
- `npx tsx --test tests/contract/security-export-operator-delegations.test.ts tests/security/export-operator-delegation.test.ts` → PASS (4/4)
- `npm test` → PASS (201/201)
- `npm audit --omit=dev` → PASS (0 vulnerability)
- Delegation smoke (`/health`, `GET /v1/security/export/operator-delegations`, `/ui/dashboard`) → PASS
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` → PASS

### Kalan riskler
- Delegation ve operator roster bugün principal-name listesi seviyesinde; external IdP/group sync henüz yok.
- Delegation, incident ve operator policy state hâlâ local file tabanlı; shared backend / multi-instance HA ihtiyacı sürüyor.
- Delegation issuance bugün tek admin onayı ile yapılıyor; ikinci approver / step-up approval modeli henüz uygulanmadı.

## 2026-04-09 Teslim Özeti

### Yapılanlar
- Security export recovery hattına yeni `GET/PUT/DELETE /v1/security/export/operator-policy` control plane'i eklendi.
- Incident workflow içindeki `acknowledge`, `clear-request` ve `clear` approval adımları tenant-scoped operator roster ile action bazında yetkilendirildi.
- Deployment default operator roster env'leri, validation ve audit telemetry eklendi; roster dışı admin recovery denemeleri fail-closed reddediliyor.
- Yeni contract/unit testler ve dokümantasyon güncellemeleri ile operator RBAC yüzeyi production-grade teslim edildi.

### Doğrulama
- `npm run typecheck` → PASS
- `npx tsx --test tests/contract/security-export-operator-policy.test.ts tests/contract/security-export-deliveries.test.ts tests/security/export-operator-policy.test.ts` → PASS (21/21)
- `npm test` → PASS (196/196)
- `npm audit --omit=dev` → PASS (0 vulnerability)
- Operator policy smoke (`/health`, `GET/PUT /v1/security/export/operator-policy`) → PASS
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` → PASS

### Kalan riskler
- Operator roster bugün principal-name listesi seviyesinde; external IdP/group sync henüz yok.
- Operator policy ve incident state hâlâ local file tabanlı; shared backend / multi-instance HA ihtiyacı sürüyor.
- Break-glass / JIT approval modeli henüz uygulanmadı.

## 2026-04-07 Teslim Özeti
- Security export delivery hattına **incident response control plane** eklendi: `GET /v1/security/export/delivery-incidents`, `POST /v1/security/export/delivery-incidents/:incidentId/acknowledge`, `POST /v1/security/export/delivery-incidents/:incidentId/clear`.
- Quarantine modeli fail-open yerine **operator-controlled fail-closed** hale getirildi: cooldown süresi dolsa bile active incident manual clear olmadan hedef tekrar açılamıyor.
- Dashboard incident tablosu ack/clear aksiyonları, revision, clear-after, ack owner ve not metadata’sını gösteriyor.
- Güvenlik katmanları güçlendirildi: stale revision guard (`409`), zorunlu incident note, yeni terminal failure geldiğinde ack reset.
- Telemetry genişletildi: `security_export_delivery_incident_opened|acknowledged|cleared` eventleri security feed’e eklendi.
- Doğrulama paketi tamamlandı: typecheck + focused contract + full test + audit + smoke + delivery-gate PASS.

## Özet
Bu koşumda en yüksek etkili günlük iyileştirme olarak **delivery analytics + automatic destination quarantine paketi** teslim edildi.

Teslimin odağı:
- security export delivery health görünürlüğünü summary/timeline/incident düzeyine çıkarmak,
- tekrar tekrar bozulan destination’lar için fail-closed quarantine guard eklemek,
- preview/sync/async/redrive zincirinin tamamını aynı health guard ile hizalamak,
- signing lifecycle contract suite state leakage’ını temizleyip test güvenini tekrar kilitlemek.

## 2026-04-06 Teslim paketi (Delivery analytics + automatic destination quarantine)
### Yapılanlar
1. **Yeni özellik — delivery analytics control plane**
   - `GET /v1/security/export/delivery-analytics` eklendi.
   - Status dağılımı, success-rate, active queue sayısı, quarantined/degraded destination sayısı, incident listesi ve timeline bucket’ları dönülüyor.
   - Dashboard delivery paneli analytics summary ve incidents tablosu kazanarak operatöre riskli hedefleri görünür kılıyor.
2. **Ciddi güvenlik iyileştirmesi — automatic destination quarantine**
   - Aynı tenant içindeki aynı destination son pencere içinde tekrarlayan terminal failure/dead-letter ürettiğinde otomatik quarantine durumuna alınıyor.
   - `preview`, sync delivery, async enqueue ve manual redrive akışları quarantine durumunda fail-closed bloke ediyor.
3. **Ciddi güvenlik iyileştirmesi — explicit failure code + async fail-closed path**
   - Quarantine kaynaklı bloklarda `destination_quarantined` failure code üretiliyor.
   - Async enqueue artık target resolution/quarantine hatalarını kontrollü `blocked` receipt + `403` ile döndürüyor; belirsiz 500 penceresi kapandı.
4. **Kalite / güvenlik iyileştirmesi — signing state leakage root-cause fix**
   - Signing registry için test reset helper eklendi.
   - Security-events contract suite içindeki global singleton state sızıntısı giderildi; signing + delivery regresyon paketi tekrar deterministik oldu.
5. **UX / DX iyileştirmesi**
   - Delivery preview summary health verdict/quarantine bilgisini gösteriyor.
   - `README.md`, `service/README.md`, `service/.env.example` yeni analytics/quarantine yüzeyiyle güncellendi.
6. **Test / kalite iyileştirmesi**
   - Delivery analytics, preview quarantine block, async quarantine block ve redrive quarantine block senaryoları contract testlerle kapsandı.
   - Tam regresyon paketi 178/178 yeşil ve dependency audit temiz.

### Verification
- `npm run typecheck` ✅
- `npm test` ✅ (**178/178**)
- `npm audit --omit=dev` ✅ (0 vulnerability)
- `PORT=18082 APP_API_KEYS=dev-admin-key npm run start` + `curl /health` + `curl /v1/security/export/delivery-analytics` + `curl /v1/security/export/deliveries/preview` smoke ✅ (`object=security_export_delivery_analytics`, `preview.allowed=true`, `preview.health.verdict=healthy`)
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` ✅ PASS

### Kalan riskler
- Delivery incident/quarantine state hâlâ local delivery kayıtlarından türetiliyor; shared backend/central incident store henüz yok.
- Quarantine clear/ack için ayrı operatör onay workflow’u yok; mevcut model süre tabanlı soğuma penceresiyle çalışıyor.
- Export delivery için merkezi egress proxy / VPC-level outbound enforcement hâlâ yok.


## Özet
Bu koşumda en yüksek etkili günlük iyileştirme olarak **signing maintenance control plane + shared-store coordination paketi** teslim edildi.

Teslimin odağı:
- signing maintenance akışını operatör için dry-run + execute kontrol düzlemine yükseltmek,
- shared signing store kullanan çoklu instance’larda stale key / duplicate rotation riskini azaltmak,
- rotate/prune mutasyonlarını lease tabanlı tek-yazarlı modele geçirmek,
- dashboard + audit + test + smoke + delivery gate kanıtını tek turda tamamlamak.

## 2026-04-05 Teslim paketi (Signing maintenance control plane + shared-store coordination)
### Yapılanlar
1. **Yeni özellik — signing maintenance API + dashboard control plane**
   - `GET /v1/security/export/signing-maintenance` ve `POST /v1/security/export/signing-maintenance/run` eklendi.
   - Dashboard signing paneli artık leader lease, revision, son maintenance koşumu, history tablosu ve dry-run/execute aksiyonlarını gösteriyor.
2. **Ciddi güvenlik iyileştirmesi — shared-store refresh / stale key closure**
   - Signing registry kritik operasyonlar öncesi store dosyasını yeniden okuyarak başka instance’ın rotate ettiği active key’e hizalanıyor.
   - Aynı store’u paylaşan instance’lar artık stale memory snapshot ile imzalama yapmıyor.
3. **Ciddi güvenlik iyileştirmesi — leader lease ile tek-yazarlı maintenance**
   - Auto-rotate/prune mutasyonları lease tabanlı koordinasyonla tek lider instance tarafından diske yazılıyor.
   - Follower instance’lar store refresh ile güncel key’e hizalanıyor; duplicate maintenance write riski daraltılıyor.
4. **Ciddi güvenlik iyileştirmesi — sync atomic persistence**
   - Rotation ve maintenance state’i atomic sync persistence ile diske yazılıyor.
   - Crash/restart anında memory-only drift ve yarım kalmış signing state riski azaltıldı.
5. **UX / DX iyileştirmesi — audit + docs + dashboard görünürlüğü**
   - `security_export_signing_maintenance_run` audit event’i eklendi.
   - `README.md`, `service/README.md`, `service/.env.example` ve dashboard maintenance yüzeyi güncellendi.
6. **Test / kalite iyileştirmesi**
   - Shared-store coordination, dry-run preview ve maintenance event feed senaryoları yeni testlerle kapsandı.
   - Tam regresyon paketi 175/175 yeşil ve dependency audit temiz.

### Verification
- `npm run typecheck` ✅
- `npm test` ✅ (**175/175**)
- `npm audit --omit=dev` ✅ (0 vulnerability)
- `PORT=18081 APP_API_KEYS=dev-admin-key npm run start` + `curl /health` + `curl /v1/security/export/signing-maintenance` + `curl /v1/security/export/keys` smoke ✅ (`maintenance_object=security_export_signing_maintenance`, `keys.maintenance.object=security_export_signing_maintenance`, `status=healthy`)
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` ✅ PASS

### Kalan riskler
- Delivery queue/audit/policy/session persistence hâlâ local file tabanlı; gerçek shared backend gerekecek.
- Lease tabanlı koordinasyon shared-file senaryosunu sertleştirir fakat tam distributed lock/consensus çözümü değildir; HA multi-node için merkezi backend gerekir.
- Export delivery için merkezi egress proxy / VPC-level outbound enforcement henüz yok.

## 2026-04-04 Teslim paketi (Signing lifecycle policy + auto-rotation guard)
### Yapılanlar
1. **Yeni özellik — signing lifecycle policy control plane**
   - `GET /v1/security/export/signing-policy` ve `PUT /v1/security/export/signing-policy` eklendi.
   - Dashboard signing paneli artık auto-rotate, rotate-after, expire-after, warn-before ve verify-retention eşiklerini yönetiyor.
2. **Ciddi güvenlik iyileştirmesi — auto-rotation + fail-closed expiry guard**
   - Active signing key rotate window'unu geçtiğinde export/delivery öncesi otomatik rotate edilebiliyor.
   - Auto-rotation kapalıysa expired key ile imzalama `503` fail-closed reddediliyor ve lifecycle state response'a ekleniyor.
3. **Ciddi güvenlik iyileştirmesi — verify-only retention pruning**
   - Verify-only anahtarlar retention süresi dolunca otomatik prune ediliyor.
   - Public JWKS yüzeyi yalnızca active + retention içindeki verify-only anahtarları yayınlıyor.
4. **Ciddi güvenlik iyileştirmesi — signing health telemetry + audit**
   - `/v1/security/export/keys` ve `/v1/security/summary` signing lifecycle health + alert durumunu expose ediyor.
   - `security_export_signing_rotated` ve `security_export_signing_policy_updated` audit event’leri eklendi.
5. **UX / DX iyileştirmesi — dashboard lifecycle görünürlüğü**
   - Signing tablosu rotate-due / expiring / expired / prune badge’leri gösteriyor.
   - Policy kaydetme akışı ve health status alanı dashboard üzerinde aktif hale geldi.
6. **Test / kalite iyileştirmesi**
   - Yeni `service/tests/contract/security-export-signing-policy.test.ts` policy CRUD + auto-rotation contract’larını kapsıyor.
   - `service/tests/security/export-signing.test.ts` lifecycle auto-rotation, prune ve expiry guard senaryolarıyla genişletildi.
   - `README.md`, `service/README.md`, `service/.env.example` yeni endpoint/env yüzeyiyle güncellendi.

### Verification
- `npm run typecheck` ✅
- `npx tsx --test tests/security/export-signing.test.ts tests/contract/security-export-signing-policy.test.ts tests/contract/security-events.test.ts` ✅ (**15/15**)
- `npm test` ✅ (**171/171**)
- `npm audit --omit=dev` ✅ (0 vulnerability)
- `PORT=18080 npx tsx api/server.ts` + `curl /v1/security/export/signing-policy` + `curl /v1/security/export?limit=5` smoke ✅ (`policy_object=security_export_signing_policy`, `lifecycle_status=healthy`, `signature.key_id=sexp_*`)
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` ✅ PASS

### Kalan riskler
- Delivery queue/audit/policy/session persistence hâlâ local file tabanlı; shared backend gerekecek.
- Signing lifecycle maintenance şu an process-local timer + request-path tetikleme ile çalışıyor; multi-instance ortamda distributed coordination yok.
- Export delivery için merkezi egress proxy / VPC-level outbound enforcement henüz yok.

## 2026-04-03 Teslim paketi (Delivery egress policy plane + target preview)
### Yapılanlar
1. **Yeni özellik — dedicated delivery-egress policy control plane**
   - `GET/PUT/DELETE /v1/security/export/delivery-policy` eklendi.
   - Tenant/deployment bazlı effective policy, mode ve allowed target rules API’den yönetilebilir hale geldi.
2. **Ciddi güvenlik iyileştirmesi — remote source policy’den ayrık egress boundary**
   - Security export delivery allowlist’i artık RAG remote source policy ile paylaşılmıyor.
   - Dedicated delivery policy plane ile egress boundary netleşti; migration için `inherit_remote_policy` modu korundu.
3. **Ciddi güvenlik iyileştirmesi — host + path-prefix enforcement**
   - Delivery allowlist kuralı host yerine `host + path-prefix` seviyesine indi.
   - Remote policy host allow olsa bile yanlış webhook path’leri `403` ile fail-closed bloke ediliyor.
4. **Ciddi güvenlik iyileştirmesi — preflight target preview + audit telemetry**
   - `POST /v1/security/export/deliveries/preview` gerçek gönderim yapmadan `allowed`, `reason`, `matched_rule`, `pinned_address` verdict’i döndürüyor.
   - `security_export_delivery_previewed`, `security_export_delivery_policy_updated`, `security_export_delivery_policy_reset` audit event’leri eklendi.
5. **UX / DX iyileştirmesi — dashboard delivery policy paneli**
   - `/ui/dashboard` içinde delivery policy yönetimi, target preview butonu ve summary metriği eklendi.
   - `README.md`, `service/README.md`, `service/.env.example` yeni endpoint/env yüzeyiyle güncellendi.
6. **Test / kalite iyileştirmesi**
   - Yeni `service/tests/contract/security-export-delivery-policy.test.ts` policy CRUD + preview + migration kontratlarını kapsıyor.
   - `service/tests/contract/security-export-deliveries.test.ts` path-scope deny ve dedicated policy enforcement ile genişletildi.

### Verification
- `npm run typecheck` ✅
- `npx tsx --test tests/contract/security-export-delivery-policy.test.ts tests/contract/security-export-deliveries.test.ts` ✅ (**12/12**)
- `npm test` ✅ (**165/165**)
- `npm audit --omit=dev` ✅ (0 vulnerability)
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` ✅ PASS

### Kalan riskler
- Delivery queue/audit/policy/session store hâlâ local file tabanlı; shared backend gerekecek.
- Signing key rotation hâlâ manual/admin tetiklemeli; otomatik expiry/rotation scheduler henüz yok.
- Deployment default backward-compatible migration için `inherit_remote_policy` kalabilir; daha sert posture için explicit `allowlist_only` önerilir.

## 2026-04-02 Teslim paketi (Dead-letter redrive + anti-rebinding pinning)
### Yapılanlar
1. **Yeni özellik — dead-letter manual redrive API + dashboard aksiyonu**
   - `POST /v1/security/export/deliveries/:deliveryId/redrive` eklendi.
   - Dashboard delivery tablosu dead-letter satırında tek tık redrive aksiyonu sunuyor.
   - Yeni queued delivery kaydı `source_delivery_id` ve `redrive_count` metadata’sı ile izleniyor.
2. **Ciddi güvenlik iyileştirmesi — remote RAG lookup→connect DNS pinning**
   - URL preview/ingest tarafında public DNS preflight sonucu gerçek TCP connect’e taşındı.
   - Redirect zinciri her hop’ta yeniden validate edilirken request aynı pinned public IP’ye bağlanıyor.
3. **Ciddi güvenlik iyileştirmesi — retry/redrive fingerprint guard**
   - Encrypted retry materyali artık hedef fingerprint’i (`origin`, `host`, `path_hash`, `matched_host_rule`) ile saklanıyor.
   - Fingerprint mismatch durumunda queue fail-closed davranıyor; tampering/replay penceresi daralıyor.
4. **Ciddi güvenlik iyileştirmesi — bounded manual replay**
   - `SECURITY_EXPORT_DELIVERY_MAX_MANUAL_REDRIVES` ile manual redrive üst sınırı getirildi.
   - `security_export_delivery_redriven` audit event’i ve `429` limit davranışı ile replay görünürlüğü sağlandı.
5. **Test / kalite iyileştirmesi**
   - Security export contract testleri redrive lifecycle + limit guard ile genişletildi.
   - Remote URL testleri gerçek pinned transport yolunu kapsayacak şekilde genişletildi.
   - Runtime docs (`service/README.md`, `service/.env.example`) yeni env/endpoint yüzeyiyle güncellendi.

### Verification
- `npm run typecheck` ✅
- `npx tsx --test tests/rag/remote-url.test.ts tests/rag/rag-service.test.ts tests/contract/rag.test.ts tests/contract/security-export-deliveries.test.ts` ✅ (**24/24**)
- `npm test -- --runInBand` ✅ (**159/159**)
- `npm audit --omit=dev --audit-level=high` ✅ (0 vulnerability)
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` ✅ PASS

### Kalan riskler
- Delivery queue/audit/policy/session persistence hâlâ local file tabanlı; shared backend gerekecek.
- Signing key rotation hâlâ manual/admin tetiklemeli; otomatik expiry/rotation policy henüz yok.
- Export egress allowlist şu an remote source policy ile paylaşılıyor; ayrı bir delivery-egress plane sonraki fazda düşünülebilir.

## 2026-04-01 Teslim paketi (Asymmetric security export signing registry)
### Yapılanlar
1. **Yeni özellik — security export signing key registry + rotation API**
   - `GET /v1/security/export/keys` ile active/verify-only signing key envanteri görünür hale geldi.
   - `POST /v1/security/export/keys/rotate` yeni active Ed25519 key üretip önceki key’i verify-only modda tutuyor.
   - `/.well-known/smart-ai/security-export-keys.json` public JWKS endpointi ile dış verifier/SIEM tarafı public key keşfi yapabiliyor.
2. **Ciddi güvenlik iyileştirmesi — asymmetric Ed25519 export signatures**
   - `GET /v1/security/export` artık hash-chain metadata yanında detached Ed25519 signature dönüyor.
   - `POST /v1/security/export/verify` signed bundle geldiğinde hem integrity chain’i hem signature’ı birlikte doğruluyor.
   - Signing private key materyali local store’da plaintext değil, AES-256-GCM encrypted-at-rest tutuluyor.
3. **Ciddi güvenlik iyileştirmesi — delivery header signing model upgrade**
   - Security export delivery headers artık symmetric HMAC yerine Ed25519 signature + `x-smart-ai-signature-key-id` + bundle key correlation ile gönderiliyor.
   - Async queue/retry/dead-letter hattı yeni signature model ile uyumlu kalacak şekilde korunup regresyon testleri genişletildi.
4. **UX / DX iyileştirmesi — dashboard signing control plane**
   - `/ui/dashboard` içinde signing key summary/metric, key tablosu ve rotate butonu eklendi.
   - README + service runtime docs yeni endpointler, env yüzeyi ve verify/JWKS akışı ile güncellendi.
5. **Test / kalite iyileştirmesi**
   - Yeni `service/tests/security/export-signing.test.ts` ile registry bootstrapping, encrypted store ve detached verify akışı koruma altına alındı.
   - Contract testler export/verify, JWKS publication, key rotation ve delivery header upgrade senaryolarını kapsayacak şekilde genişletildi.

### Verification
- `npm run typecheck` ✅
- `npm test` ✅ (**157/157**)
- Ad-hoc tsx smoke doğrulaması ✅ (`GET /v1/security/export` → `200` / `signature.algorithm=Ed25519`, `GET /.well-known/smart-ai/security-export-keys.json` → `200`)
- `npm audit --omit=dev` ✅ (0 vulnerability)
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` ✅ PASS

### Kalan riskler
- Dead-letter item’ları için özel redrive endpointi henüz yok.
- Remote URL fetch hattında lookup ile gerçek connect arasında tam anti-rebinding pinning yok.
- Delivery queue/audit/policy/session persistence hâlâ local file tabanlı; shared backend gerekecek.

## 2026-03-31 Teslim paketi (Resilient security export delivery queue)
### Yapılanlar
1. **Yeni özellik — async security export delivery queue**
   - `POST /v1/security/export/deliveries` artık `mode=async` ile receipt’i `queued` olarak döndürüp retry/backoff lifecycle başlatıyor.
   - `GET /v1/security/export/deliveries` endpointi `status` filtresiyle queue/dead-letter görünürlüğü veriyor.
2. **Ciddi güvenlik iyileştirmesi — encrypted retry payload store**
   - Retry queue materyali AES-256-GCM ile encrypted-at-rest saklanıyor.
   - Receipt history plaintext export bundle veya query secret’larını sızdırmıyor.
3. **Ciddi güvenlik iyileştirmesi — idempotency + active-cap flood koruması**
   - `Idempotency-Key` replay-safe hale getirildi; aynı key + farklı payload `409`, aynı payload tekrarında receipt reuse.
   - Tenant başına aktif async delivery limiti ile queue flood / egress abuse yüzeyi daraltıldı.
4. **Ciddi güvenlik/operasyon iyileştirmesi — dead-letter telemetry**
   - Retryable HTTP/network failure’lar automatic backoff ile tekrar deneniyor.
   - Max attempt sonrası receipt `dead_letter` oluyor ve security feed’e `security_export_delivery_dead_lettered` kanıtı düşüyor.
5. **UX / DX iyileştirmesi**
   - Dashboard delivery paneli sync/async mod seçimi ve retry metadata görünürlüğü ile güncellendi.
   - README + service runtime docs + env example yeni async/delivery tuning yüzeyiyle güncellendi.

### Verification
- `npm run typecheck` ✅
- `npx tsx --test tests/contract/security-export-deliveries.test.ts tests/contract/security-events.test.ts` ✅ (**11/11**)
- `npm test` ✅ (**154/154**)
- `npm audit --omit=dev` ✅ (0 vulnerability)
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` ✅ PASS

### Kalan riskler
- Dead-letter item’ları için özel redrive endpointi henüz yok.
- HMAC signing symmetric modelde; asymmetric verifier/key rotation registry backlog’da.
- Delivery queue/audit/policy persistence hâlâ local file tabanlı; shared backend gerekecek.

## 2026-03-30 Teslim paketi (Tamper-evident security export delivery)
### Yapılanlar
1. **Yeni özellik — güvenli webhook/SIEM export delivery API**
   - `GET /v1/security/export/deliveries` ile recent receipt history eklendi.
   - `POST /v1/security/export/deliveries` ile export bundle allowlisted hedefe push edilebiliyor.
   - Dashboard’a webhook URL + window + limit kontrollü delivery paneli eklendi.
2. **Ciddi güvenlik iyileştirmesi — egress allowlist + HTTPS-only enforcement**
   - Delivery yalnızca HTTPS hedeflere açılıyor.
   - Embedded credential içeren URL’ler ve allowlist dışı host/port’lar bloklanıyor.
   - Export egress, tenant remote source allowlist ile sınırlandı.
3. **Ciddi güvenlik iyileştirmesi — DNS pinning + public-network guard**
   - Hedef public DNS ile resolve edilip pinned IP üzerinden çağrılıyor.
   - Private/local/reserved IP hedefleri fail-closed reddediliyor.
4. **Ciddi güvenlik iyileştirmesi — HMAC-imzalı tamper-evident transfer**
   - `content-digest`, `x-smart-ai-signature`, `x-smart-ai-signature-input`, `x-smart-ai-head-chain-hash` header’ları eklendi.
   - Receipt store path/query secret’larını loglamıyor; redacted destination metadata tutuyor.
5. **Test / kalite iyileştirmesi**
   - Yeni contract test dosyası delivery success/block/read-only deny senaryolarını kapsıyor.
   - Tam regresyon paketi 152/152 yeşil ve dependency audit temiz.

### Verification
- `npm run typecheck` ✅
- `npx tsx --test tests/contract/security-events.test.ts tests/contract/security-export-deliveries.test.ts` ✅ (**9/9**)
- `npm test` ✅ (**152/152**)
- `npm audit --omit=dev` ✅ (0 vulnerability)
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` ✅ PASS

### Kalan riskler
- Delivery retry/backoff queue henüz yok; başarısız upstream için manual retry gerekiyor.
- İmza symmetric HMAC tabanlı; asymmetric verifier/key rotation backlog’da.
- Egress allowlist şu an remote source allowlist ile paylaşılıyor; ayrı export-egress policy plane sonraki fazda düşünülebilir.

## 2026-03-29 Teslim paketi (Tamper-evident security export pipeline)
### Yapılanlar
1. **Yeni özellik — security export + verify API**
   - `GET /v1/security/export` ile tenant bazlı audit evidence export eklendi.
   - `POST /v1/security/export/verify` ile export bundle server-side doğrulanabiliyor.
2. **Ciddi güvenlik iyileştirmesi — tamper-evident hash chain**
   - Audit eventler artık `sequence`, `prev_chain_hash`, `chain_hash` alanlarıyla zincirleniyor.
   - Persisted audit store eski snapshot’lardan geriye uyumlu biçimde hash-chain’e yükseltiliyor.
3. **Ciddi güvenlik iyileştirmesi — least-privilege export gating**
   - Export ve verify admin scope arkasına alındı.
   - Read-only credential summary okuyabiliyor ama evidence export edemiyor.
4. **Ops / UX iyileştirmesi — gerçek security summary + dashboard download**
   - `/v1/security/summary` artık risk + integrity telemetry döndürüyor.
   - Dashboard güvenlik kartı gerçek summary verisiyle besleniyor ve admin kullanıcı tek tık export indirebiliyor.
5. **Test / kalite iyileştirmesi**
   - Security contract ve audit-log testleri hash-chain, tamper detection ve role gating senaryolarıyla genişletildi.

### Verification
- `npm run typecheck` ✅
- `npm test` ✅ (**149/149**)
- `npm audit --omit=dev` ✅ (0 vulnerability)
- `PORT=3457 npm run start` + `curl /v1/security/summary` + `curl /v1/security/export` ✅ smoke başarılı (`summary=200`, `export=200`, `integrity=true`)
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` ✅ PASS

### Kalan riskler
- Export hattı şu an pull-based; webhook/SIEM push delivery backlog’da.
- Export verify server-side; public-key dağıtımlı bağımsız verifier henüz yok.
- Audit/session/policy persistence hâlâ shared backend’e taşınmadı.

## 2026-03-28 Teslim paketi (Tenant remote source policy control plane)
### Yapılanlar
1. **Yeni özellik — tenant remote source policy API + dashboard**
   - `GET/PUT/DELETE /v1/rag/remote-policy` eklendi.
   - Dashboard’a remote source policy paneli ve özet metriği eklendi.
2. **Ciddi güvenlik iyileştirmesi — secure-by-default ingest governance**
   - Deployment varsayılanı `preview_only` oldu; explicit tenant policy olmadan remote URL ingest kapalı.
   - `allowlist_only`, `open`, `disabled` modları ile operasyonel esneklik korundu.
3. **Ciddi güvenlik iyileştirmesi — host allowlist sertleştirmesi**
   - Exact public host/IP ve `*.example.com` wildcard kuralları destekleniyor.
   - Unicode host girdileri punycode normalize ediliyor; private/local host girdileri reddediliyor.
4. **Ciddi güvenlik iyileştirmesi — telemetry + risk analytics**
   - `rag_remote_policy_denied`, `rag_remote_policy_updated`, `rag_remote_policy_reset` eventleri security feed’e ve risk scoring’e eklendi.
5. **DX / UX iyileştirmesi**
   - `README.md`, `service/README.md`, `service/.env.example` güncellendi.
   - Dashboard’daki RAG belge metriği veri eşlemesi düzeltildi.

### Verification
- `npm run typecheck` ✅
- `npm test` ✅ (**143/143**)
- `npm audit --omit=dev --audit-level=high` ✅ (0 vulnerability)
- `PORT=3456 npm run start` + `curl /health` + `curl /ui/dashboard` ✅ smoke başarılı
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` ✅ PASS

### Kalan riskler
- `allowlist_only` modunda preview hâlâ public-safe fetch yapabiliyor; daha sert preview governance opsiyonel fazda değerlendirilmeli.
- DNS rebinding’e karşı lookup→connect arası tam pinning henüz yok.
- SIEM/webhook export hattı hâlâ backlog’da.

## 2026-03-27 Teslim paketi (Secure remote RAG URL ingest + preview gate)
### Yapılanlar
1. **Yeni özellik — güvenli remote URL preview**
   - `POST /v1/rag/url-preview` ile operatör ingest öncesi `final_url`, `redirects`, `content_type`, `content_length_bytes`, `excerpt` preview alabiliyor.
2. **Ciddi güvenlik iyileştirmesi — SSRF/private-network blokları**
   - Remote fetch hattı localhost, private RFC1918 aralıkları, link-local/meta-data IP’leri, credential gömülü URL’ler ve allowlist dışı portları reddediyor.
3. **Ciddi güvenlik iyileştirmesi — redirect + payload guard**
   - Redirect hop’ları tekrar validate ediliyor.
   - Redirect loop / missing location / unsafe target durumları bloklanıyor.
   - MIME allowlist + byte cap + timeout korumaları eklendi.
4. **Gözlemlenebilirlik iyileştirmesi**
   - `rag_remote_url_blocked`, `rag_remote_url_fetch_failed`, `rag_remote_url_previewed`, `rag_remote_url_ingested` eventleri security audit feed’e eklendi.
5. **DX / dokümantasyon iyileştirmesi**
   - `README.md`, `service/README.md`, `service/.env.example` remote fetch policy ve yeni endpoint ile güncellendi.

### Verification
- `npm run typecheck` ✅
- `npm test` ✅ (**133/133**)
- `npm audit --omit=dev --audit-level=high` ✅ (0 vulnerability)
- `npx tsx - <<'EOF' ... remote preview + ingest + search smoke ... EOF` ✅ (`preview=200 ingest=200 search=200 hits=1`)
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` ✅ PASS

### Kalan riskler
- DNS rebinding’e karşı lookup→connect arası tam pinning henüz yok; egress-level enforcement sonraki fazda değerlendirilmeli.
- Tenant bazlı domain allowlist / approval workflow henüz eklenmedi.
- Security event export/SIEM bağlantısı hâlâ backlog’da.

## 2026-03-26 Teslim paketi (Persistent security control plane + admin session management)
### Yapılanlar
1. **Yeni özellik — tenant admin session control plane**
   - `GET /v1/ui/sessions` → aktif dashboard/chat session inventory
   - `POST /v1/ui/sessions/:sessionId/revoke` → hedef session kapatma
   - `POST /v1/ui/sessions/revoke-all` → bulk revoke (`exceptCurrent=true` desteği)
2. **Ciddi güvenlik iyileştirmesi — hashed UI session persistence**
   - `UI_SESSION_STORE_FILE` ile file-backed restore eklendi.
   - Plaintext token diske yazılmıyor; yalnızca hash + metadata tutuluyor.
   - Session inventory/revoke akışları restart sonrası da çalışabilir hale geldi.
3. **Ciddi güvenlik iyileştirmesi — persisted security audit evidence**
   - `SECURITY_AUDIT_STORE_FILE` ile sanitize edilmiş audit eventler restart sonrası korunuyor.
   - Bounded retention ve redaction kuralları hydrate/persist akışında korunuyor.
4. **Ciddi güvenlik iyileştirmesi — dependency advisory closure**
   - `fastify` güvenli sürüme yükseltildi.
   - `npm audit --omit=dev` yeniden 0 vulnerability durumuna döndü.
5. **UX / ops iyileştirmesi**
   - Dashboard'a aktif session tablosu eklendi.
   - “Diğer Oturumları Kapat” aksiyonu ile operatör mevcut oturumu düşürmeden incident-response uygulayabiliyor.

### Verification
- `npm run typecheck` ✅
- `npm test -- --runInBand` ✅ (**124/124**)
- `npm audit --omit=dev` ✅ (0 vulnerability)
- `npx tsx -e "...ui session admin smoke..."` ✅ (`list=200`, `listCount=2`, `revoke=200`, `revoked=1`)
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` ✅ PASS

### Kalan riskler
- Session/audit persistence şu an local disk tabanlı; multi-instance kurulumda shared backend gerekecek.
- Session control plane tenant-admin seviyesinde; tenant içi kullanıcı bazlı sahiplik/RBAC workflow henüz yok.
- SIEM/webhook export pipeline hâlâ backlog’da.

## 2026-03-24 Teslim paketi (Tenant model policy + fail-closed enforcement)
### Yapılanlar
1. **Yeni özellik — tenant model policy API**
   - `GET /v1/model-policy` → effective policy görüntüleme
   - `PUT /v1/model-policy` → tenant allowlist + default model güncelleme
   - `DELETE /v1/model-policy` → deployment defaults’a reset
2. **Ciddi güvenlik iyileştirmesi — tenant-level model enforcement**
   - `/v1/chat/completions` ve `/v1/jobs/research` artık tenant effective policy dışındaki modelleri reddediyor.
   - `model` alanı verilmezse kontrollü biçimde tenant default model uygulanıyor.
   - `/v1/models` yanıtı tenant effective model listesi + `default_model` metadata’sı döndürüyor.
3. **Ciddi güvenlik iyileştirmesi — fail-closed stale policy handling**
   - Tenant policy yalnızca deployment allowlist içinden yazılabiliyor.
   - Deployment policy değişip tenant policy stale hale gelirse sistem sessizce geniş yetkiye dönmüyor; invalid policy durumunda istekler güvenli şekilde reddediliyor.
   - Yeni audit eventleri: `model_policy_updated`, `model_policy_reset`, `model_policy_change_rejected`.
4. **DX / UX iyileştirmesi**
   - Dashboard’a tenant model policy yönetim paneli eklendi.
   - Chat UI, tenant default modeli otomatik seçiyor.
   - README + service runtime dokümantasyonu yeni env/endpoint yüzeyiyle güncellendi.

### Verification
- `./node_modules/.bin/tsc --noEmit` ✅
- `./node_modules/.bin/tsx --test "tests/**/*.test.ts"` ✅ (**113/113**)
- `APP_API_KEYS=smoke-key ... ./node_modules/.bin/tsx -e "...model policy smoke..."` ✅ (`put=200`, `chat=200`, `models=200`, `selectedModel=openai/gpt-4o-mini`)
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` ✅ PASS
- `npm audit --omit=dev --audit-level=high` ⚠️ Host npm kurulumu `semver` modülü eksik olduğu için çalıştırılamadı.

### Kalan riskler
- Tenant model policy store dosya tabanlı; multi-instance kurulumda shared store’a taşınmalı.
- Policy değişiklikleri için RBAC/approval workflow henüz yok.
- Host npm toolchain kırık olduğu için dependency audit bu koşumda doğrulanamadı.

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

## 2026-03-22 Teslim ek paketi (UI session lifecycle hardening + token rotation)
### Yapılan ana geliştirme (yeni özellik)
- UI auth yüzeyine **session lifecycle API** eklendi:
  - `GET /ui/session` (aktif session introspection)
  - `POST /ui/session/refresh` (token rotation)
- Dashboard/Chat frontend, token bitimine yakın otomatik refresh yapacak şekilde güncellendi.

### Aynı koşumdaki ciddi güvenlik iyileştirmeleri
1. **Idle session timeout enforcement** eklendi (`UI_SESSION_MAX_IDLE_SECONDS`).
2. **User-Agent fingerprint binding** eklendi; uyumsuz kullanımda token revoke edilir.
3. **Session abuse/memory-DoS koruması** için tenant/global session cap + oldest eviction eklendi.
4. Security telemetry, session-anomaly event tipleriyle genişletildi.

### Verification
- `npm run typecheck` ✅
- `npm test` ✅ (104/104)
- `npm audit --omit=dev --audit-level=high` ✅ (0 vulnerability)
- `delivery-gate` ✅ PASS

### Kalan riskler
- Session store process-memory olduğu için servis restartında aktif sessionlar düşer (fail-safe; kullanıcı re-login gerekir).
- User-Agent binding tek başına güçlü cihaz imzası değildir; sonraki fazda multi-signal fingerprint önerilir.

## 2026-03-25 Teslim paketi (Scoped API keys + auth context + UI session origin binding)
### Yapılanlar
1. **Yeni özellik — scoped credential + auth context introspection**
   - `APP_API_KEY_DEFINITIONS` ile read / operate / admin ayrımı eklendi.
   - Yeni endpoint: `GET /v1/auth/context`
   - Dashboard ve Chat UI artık aktif session/credential yetkisini okuyup arayüzü otomatik kısıtlıyor.
2. **Ciddi güvenlik iyileştirmesi — admin yüzeyi least-privilege gating**
   - `/v1/model-policy`, `/v1/keys/openrouter*`, `/v1/mcp/reset`, `/v1/mcp/flush` artık admin scope gerektiriyor.
   - Read-only ve operate-only credential’lar tenant gözlem/operasyon akışını bozmazken admin aksiyonları çalıştıramıyor.
3. **Ciddi güvenlik iyileştirmesi — UI session scope inheritance**
   - `/ui/session` ve `/ui/session/refresh` akışları principal adı + scope setini taşıyor.
   - Böylece sınırlı bir API key ile açılan browser oturumu, arka kapıdan admin yetkisine sıçrayamıyor.
4. **Ciddi güvenlik iyileştirmesi — origin-bound unsafe API writes**
   - UI session token ile yapılan state-changing `/v1/*` çağrıları allowlisted Origin’e bağlandı.
   - Token replay / cross-origin kötüye kullanım penceresi daraltıldı.
5. **Telemetry + UX iyileştirmesi**
   - Yeni audit event: `api_scope_denied`
   - Risk summary privilege probing sinyallerini yükseltebiliyor.
   - Dashboard/Chat UI yetkiye göre admin/operate kontrollerini disable edip kullanıcıya görünür capability özeti veriyor.

### Verification
- `npm run typecheck` ✅
- `npm test` ✅ (**118/118**)
- `npx tsx --test tests/contract/auth-context.test.ts` ✅ (**5/5**)
- `npm audit --omit=dev` ✅ (0 vulnerability)
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` ✅ PASS

### Kalan riskler
- API key registry env tabanlı; secret manager veya merkezi store ile rotation yönetimi daha iyi olacaktır.
- UI session ve audit event store process-memory; multi-instance kurulumda shared persistence gerekecektir.
- Tenant içi kullanıcı bazlı tam RBAC/approval workflow sonraki iterasyon konusudur.
