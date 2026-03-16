# SECURITY REPORT — OpenRouter Agentic Intelligence API

## Kapsam
Bu iterasyonda kontrol edilen güvenlik yüzeyleri:
- AuthN/AuthZ (Bearer API key + tenant header)
- Tenant isolation (tenant bazlı key ve job erişimi)
- Input validation (zod)
- Secret management (AES-256-GCM encrypted-at-rest)
- Rate limit (tenant bazlı fixed window)
- Budget guard (step/tool/runtime)

## Güven Sınırları
- Kullanıcı girdisi: `/v1/*` endpoint body + headers
- İç sistem yüzeyi: key-store dosya erişimi, worker memory queue
- Üçüncü taraf servisler: OpenRouter, web/wikipedia/financial dış kaynakları

## Kontrol Sonuçları
| Alan | Durum | Not |
|---|---|---|
| Auth / Authorization | ✅ | `/v1/*` auth zorunlu; tenant id zorunlu |
| Validation | ✅ | request body zod doğrulaması aktif |
| Secrets | ✅ | tenant OpenRouter key AES-256-GCM ile şifreli saklanıyor |
| Dependencies | ✅ | npm audit: 0 vulnerability |
| Logging | ⚠️ | yapılandırılmış log var, production log-redaction eklenebilir |
| Abuse Guard | ✅ | rate-limit + runtime/tool budget guard |
| Tenant Isolation | ✅ | key/job erişimi tenant bazlı sınırlandı |

## Abuse / Failure Senaryoları
- Senaryo: Yetkisiz çağrı
  - Etki: API abuse
  - Azaltma: Bearer auth + tenant zorunluluğu + rate-limit

- Senaryo: Key-store dosyasına erişim
  - Etki: key sızıntısı
  - Azaltma: encrypted-at-rest + dosya izinlerinin sıkı tutulması + KMS önerisi

- Senaryo: Tool timeout
  - Etki: gecikme/yanıt kalitesi düşüşü
  - Azaltma: AbortSignal timeout + verifier fallback

## Kalan Açıklar / İyileştirme Önerileri
1. Master key’in KMS/HSM üzerinden yönetilmesi (şu an env tabanlı)
2. Prod ortamda merkezi rate-limit (Redis) ve WAF entegrasyonu
3. Stream endpoint için abuse-aware connection throttling
4. Security event audit trail’i dış SIEM’e akıtma

## Sonuç
Sistem production-leaning güvenlik tabanı ile çalışır durumda. Kritik güvenlik kontrolleri aktif, kalan maddeler hardening backlog’una alındı.
