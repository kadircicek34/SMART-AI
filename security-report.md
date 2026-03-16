# SECURITY REPORT — SMART-AI v0.11

## Kapsam
Bu iterasyonda kontrol edilen güvenlik/dayanıklılık yüzeyleri:
- AuthN/AuthZ (Bearer API key + tenant header)
- Tenant isolation (RAG + Memory)
- Input validation (zod)
- Tool safety (policy allowlist + loop guard)
- QMD subprocess safety (`execFile`, timeout)
- Remote MCP call safety (`mcporter` controlled args + adaptive timeout + circuit breaker)
- MCP health snapshot persistence güvenliği (local disk store)
- Dependency güvenliği (`npm audit`)

## Kontrol Sonuçları
| Alan | Durum | Not |
|---|---|---|
| Auth / Tenant scope | ✅ | `/v1/*` tenant sınırları korunuyor |
| Tool policy | ✅ | mevzuat/borsa/yargı tool allowlist kontrollü |
| MCP call güvenliği | ✅ | sabit command template + JSON args + adaptive timeout + circuit guard |
| MCP health persistence | ✅ | snapshot local dosyaya atomik tmp→rename ile yazılıyor |
| Memory/RAG izolasyonu | ✅ | cross-tenant erişim bloklu |
| Dependencies | ✅ | `npm audit --omit=dev` sonucu 0 vuln |

## MCP Özel Güvenlik Notları
- Remote MCP çağrıları yalnızca config'teki izinli URL setine yönleniyor.
- `tr-mcp-search.ts` ham shell string değil arg-list ile çalışıyor.
- Circuit-open durumda kontrollü degrade veriliyor; gereksiz upstream baskısı azaltılıyor.
- Snapshot dosyası sadece operasyonel metrik içeriyor; gizli anahtar taşımaz.

## Kalan İyileştirme Alanları
1. MCP health metriklerini external telemetry backend'e taşıma (Prometheus/OTEL)
2. MCP retry budget'i circuit state'e göre policy-driven birleştirme
3. Memory/RAG encrypt-at-rest data key + KMS
4. RAG URL ingest SSRF hardening

## Sonuç
MCP dayanıklılık katmanı güvenlik tabanını bozmadan kalıcı hale getirildi; restart sonrası resiliency continuity sağlandı.
