# TEST REPORT — SMART-AI v0.7 (QMD Search + Retrieval Telemetry)

## Test Stratejisi
- Contract tests: OpenAI-compatible endpointler + RAG + Memory endpointleri
- Security tests: key-store encryption + tool policy allowlist
- Unit tests: verifier quality gate, deep_research bütçe/concurrency, qmd tool davranışı, memory retrieval/hotness

## Çalıştırılan Verification Komutları
| Komut | Sonuç | Kanıt |
|---|---|---|
| `npm run typecheck` | ✅ | TS hata yok |
| `npm test` | ✅ | **36/36 test geçti** |
| `npm audit --omit=dev` | ✅ | 0 vulnerability |
| `scripts/delivery-gate.sh <project-dir>` | ✅ | PASS |

## Öne Çıkan Yeni Testler
- `tests/tools/qmd-search.test.ts` ✅ yeni
  - collection auto-add
  - disabled mode davranışı
  - non-json output graceful handling
- `tests/memory/memory-service.test.ts` ✅ genişletildi
  - retrieval metrics doğrulaması
  - hotness score davranışı
- `tests/orchestrator/verifier.test.ts` ✅ genişletildi
  - project-doc query için `qmd_search` önerisi
  - qmd evidence ile yeterlilik doğrulaması
- `tests/tools/deep-research.test.ts` ✅ güncellendi
  - deep_research içinde QMD local source birleştirme

## Regresyon Durumu
- OpenRouter retry/backoff regresyonu yok
- RAG endpoint regresyonu yok
- Memory API regresyonu yok
- Policy engine’de yeni `qmd_search` allowlist doğrulandı

## Sonuç
QMD entegrasyonu + memory telemetry/hotness değişiklikleri test kapsamı altında üretim çizgisinde doğrulandı.
