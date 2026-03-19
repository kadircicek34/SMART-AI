# DELIVERY — SMART-AI v1.2 (UI Session Auth Hardening)

## Özet
Bu koşumda en yüksek etkili günlük iyileştirme olarak **UI güvenlik sertleştirmesi** teslim edildi.

Önceki sürümde Chat UI API key'i localStorage'da tutuyordu. Bu iterasyonda:
- API key browserda kalıcı saklanmıyor,
- kısa ömürlü tenant-scope session token akışına geçildi,
- `/v1/*` auth middleware'i bu tokenları güvenli şekilde doğrulayacak hale getirildi.

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
