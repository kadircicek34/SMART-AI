# DELIVERY — SMART-AI v0.11 (MCP Health Persistence + Flush Ops)

## Özet
Bu koşumda SMART-AI MCP dayanıklılık katmanı bir üst seviyeye taşındı:
- MCP health metrikleri artık sadece memory’de değil, **disk snapshot** olarak da tutuluyor.
- Servis restart sonrası circuit/latency sinyalleri seed edilerek devam ediyor.
- Operasyon için manuel persist endpointi eklendi: `POST /v1/mcp/flush`.

## Teslim Edilen Ana Bileşenler
1. **Persistence Store (yeni)**
   - `service/mcp-health/store.ts`
   - snapshot read/write + sanitize + atomic write
2. **Circuit Restore**
   - `service/mcp-health/circuit-breaker.ts`
   - seed snapshot ile startup restore
3. **Runtime Persistence Scheduler**
   - `service/mcp-health/index.ts`
   - debounce’lu auto-persist + `flushMcpHealthSnapshot`
4. **API Surface**
   - `service/api/routes/mcp-health.ts`
   - yeni endpoint: `POST /v1/mcp/flush`
5. **Config/Ops**
   - `service/config.ts`, `service/.env.example`
   - `MCP_HEALTH_PERSIST_ENABLED`, `MCP_HEALTH_STORE_FILE`, `MCP_HEALTH_PERSIST_DEBOUNCE_MS`
6. **Contracts & Docs**
   - `contracts/platform-extensions.yaml` mcp endpoints güncellendi
   - README / service README güncellendi

## Verification Özeti
| İddia | Kanıt | Sonuç |
|---|---|---|
| Kod derleniyor | `npm run typecheck` | ✅ |
| Testler geçiyor | `npm test` (**53/53**) | ✅ |
| Güvenlik bağımlılık taraması temiz | `npm audit --omit=dev` | ✅ |
| Teslim kapıları geçildi | `scripts/delivery-gate.sh` | ✅ PASS |

## Bilinen Sınırlar
- Snapshot persistence local disk üzerinde; multi-instance shared store henüz yok.
- Circuit breaker granularity şu an server-bazlı; tool-bazlı ayrıştırma gelecek iterasyon.

## GitHub Senkronizasyonu
- Repo: `https://github.com/kadircicek34/SMART-AI`
- Branch: `main`
- Bu koşumda MCP (`github-work.push_files`) ile push yapılacak.
