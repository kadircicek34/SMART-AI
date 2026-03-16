# TEST REPORT — SMART-AI v0.11 (MCP Health Persistence)

## Test Stratejisi
- Contract tests: OpenAI-compatible + RAG + Memory + MCP health endpointleri
- Security tests: key-store + policy allowlist
- Unit tests: orchestrator/verifier, deep_research, financial runtime, qmd, memory, MCP adapters, MCP circuit/store

## Çalıştırılan Verification Komutları
| Komut | Sonuç | Kanıt |
|---|---|---|
| `npm run typecheck` | ✅ | TS hata yok |
| `npm test` | ✅ | **53/53 test geçti** |
| `npm audit --omit=dev` | ✅ | 0 vulnerability |
| `scripts/delivery-gate.sh <project-dir>` | ✅ | PASS |

## Bu Koşumdaki Yeni Testler
- `service/tests/mcp-health/store.test.ts` ✅
  - snapshot read/write roundtrip
- `service/tests/mcp-health/circuit-breaker.test.ts` ✅ güncellendi
  - persisted seed ile circuit restore davranışı
- `service/tests/contract/mcp-health.test.ts` ✅ güncellendi
  - yeni `POST /v1/mcp/flush` endpoint doğrulaması

## Regresyon Durumu
- OpenRouter retry/backoff regresyonu yok
- RAG + Memory + QMD regresyonu yok
- Financial provider fallback regresyonu yok
- Mevzuat/Borsa/Yargı MCP adapter akışı regresyonsuz

## Sonuç
MCP resilience katmanı restart sonrası kalıcılık kazanacak şekilde olgunlaştırıldı ve tüm test paketi yeşil geçti.
