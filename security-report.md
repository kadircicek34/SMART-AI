# SECURITY REPORT — SMART-AI v0.9

## Kapsam
Bu iterasyonda kontrol edilen güvenlik/dayanıklılık yüzeyleri:
- AuthN/AuthZ (Bearer API key + tenant header)
- Tenant isolation (RAG + Memory)
- Input validation (zod)
- Tool safety (policy allowlist + loop guard)
- QMD subprocess safety (`execFile`, timeout)
- Remote MCP call safety (`mcporter` controlled args + timeout)
- Dependency güvenliği (`npm audit`)

## Kontrol Sonuçları
| Alan | Durum | Not |
|---|---|---|
| Auth / Tenant scope | ✅ | `/v1/*` tenant sınırları korunuyor |
| Tool policy | ✅ | yeni `mevzuat_mcp_search`, `borsa_mcp_search`, `yargi_mcp_search` allowlist kontrollü |
| QMD güvenliği | ✅ | shell interpolation yok, timeout var |
| MCP call güvenliği | ✅ | sabit command template + JSON args + timeout |
| Memory/RAG izolasyonu | ✅ | cross-tenant erişim bloklu |
| Dependencies | ✅ | `npm audit --omit=dev` sonucu 0 vuln |

## MCP Özel Güvenlik Notları
- Remote MCP çağrıları yalnızca config'teki izinli URL setine yönleniyor.
- Aracı katman (`tr-mcp-search.ts`) ham shell string yerine arg-list ile çalışıyor.
- Yargı aramada fallback açık olsa da hata durumunda kontrollü degrade ediliyor.

## Kalan İyileştirme Alanları
1. MCP health telemetry + circuit breaker
2. MCP call retry budget / adaptive timeout
3. Memory/RAG encrypt-at-rest data key + KMS
4. RAG URL ingest SSRF hardening

## Sonuç
Üç yeni remote MCP entegrasyonu güvenlik tabanı bozulmadan eklendi; policy ve runtime guardrail’ler korunuyor.
