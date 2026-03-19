# SECURITY REPORT — SMART-AI v1.2

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
