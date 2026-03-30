# TEST REPORT — SMART-AI v1.11 (Tamper-Evident Security Export Delivery)

## Test Stratejisi
- Contract tests: OpenAI-compatible + RAG + Memory + MCP + UI endpointleri
- Security tests: key-store + policy allowlist + UI session token auth akışı
- Unit tests: orchestrator/verifier, deep_research, financial runtime, qmd, memory, MCP circuit/store

## 2026-03-30 Ek doğrulama (Tamper-evident security export delivery)
- `npm run typecheck` ✅
- `npx tsx --test tests/contract/security-events.test.ts tests/contract/security-export-deliveries.test.ts` ✅ (**9/9**)
- `npm test` ✅ (**152/152**)
- `npm audit --omit=dev` ✅ (0 vulnerability)
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` ✅ PASS
- Yeni testler / güncellemeler:
  - `service/tests/contract/security-export-deliveries.test.ts`
    - allowlist dışı host için admin-block + redacted receipt doğrulaması
    - HMAC-imzalı delivery dispatch contract doğrulaması
    - read-only credential için list/create deny doğrulaması
  - `service/tests/contract/security-events.test.ts`
    - export/verify akışında regresyon doğrulaması sürdürüldü
  - Dashboard smoke etkisi
    - yeni delivery paneli aynı `/ui/dashboard` yüzeyinden çalışıyor; endpoint contract testleri ve tam regresyon paketi ile doğrulandı

## 2026-03-29 Ek doğrulama (Tamper-evident security export pipeline)
- `npm run typecheck` ✅
- `npm test` ✅ (**149/149**)
- `npm audit --omit=dev` ✅ (0 vulnerability)
- `PORT=3457 npm run start` + `curl /v1/security/summary` + `curl /v1/security/export` smoke ✅ (`summary=200`, `export=200`, `integrity=true`)
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` ✅ PASS
- Yeni testler / güncellemeler:
  - `service/tests/contract/security-events.test.ts`
    - gerçek `GET /v1/security/summary` contract doğrulaması
    - admin-scope `GET /v1/security/export` bundle doğrulaması
    - `POST /v1/security/export/verify` ile tamper detection doğrulaması
    - read-only credential için export deny + summary allow
  - `service/tests/security/audit-log.test.ts`
    - `sequence` / `prev_chain_hash` / `chain_hash` zinciri doğrulaması
    - export bundle integrity metadata doğrulaması
    - kasıtlı payload değişikliği ile chain-hash mismatch doğrulaması
    - persisted audit snapshot restore sonrası hash-chain doğrulaması

## 2026-03-28 Ek doğrulama (Tenant remote source policy control plane)
- `npm run typecheck` ✅
- `npm test` ✅ (**143/143**)
- `npm audit --omit=dev --audit-level=high` ✅ (0 vulnerability)
- `PORT=3456 npm run start` + `curl /health` + `curl /ui/dashboard` smoke ✅
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` ✅ PASS
- Yeni testler / güncellemeler:
  - `service/tests/contract/rag-remote-policy.test.ts`
    - effective deployment default remote policy
    - admin update/reset akışı
    - read-only credential için admin deny
  - `service/tests/contract/rag.test.ts`
    - preview response içinde policy verdict doğrulaması
    - preview-only modda ingest block + `rag_remote_policy_denied` audit event doğrulaması
    - allowlist onayı sonrası remote ingest contract smoke
  - `service/tests/security/remote-policy.test.ts`
    - punycode normalization
    - wildcard/exact host matching
    - private-network host rule reject
  - `service/tests/rag/rag-service.test.ts`
    - preview-only modda policy verdict
    - allowlist approval sonrası preview + ingest success

## 2026-03-27 Ek doğrulama (Secure remote RAG URL ingest + preview gate)
- `npm run typecheck` ✅
- `npm test` ✅ (**133/133**)
- `npm audit --omit=dev --audit-level=high` ✅ (0 vulnerability)
- `npx tsx - <<'EOF' ... remote preview + ingest + search smoke ... EOF` ✅ (`preview=200 ingest=200 search=200 hits=1`)
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` ✅ PASS
- Yeni testler / güncellemeler:
  - `service/tests/contract/rag.test.ts`
    - `POST /v1/rag/url-preview` contract doğrulaması
    - remote URL ingest → redirect/final URL/searchable content smoke
    - private-network target block + security event evidence doğrulaması
  - `service/tests/rag/rag-service.test.ts`
    - preview + final URL metadata doğrulaması
  - `service/tests/rag/remote-url.test.ts`
    - direct private/link-local block
    - credentialed URL block
    - redirect revalidation
    - content-type / oversized response guard

## 2026-03-26 Ek doğrulama (Persistent security control plane + admin session management)
- `npm run typecheck` ✅
- `npm test -- --runInBand` ✅ (**124/124**)
- `npm audit --omit=dev` ✅ (0 vulnerability)
- `npx tsx -e "...ui session admin smoke..."` ✅ (`list=200`, `listCount=2`, `revoke=200`, `revoked=1`)
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` ✅ PASS
- Yeni testler / güncellemeler:
  - `service/tests/contract/ui-sessions.test.ts`
    - admin session ile active session inventory
    - targeted revoke
    - revoke-all (`exceptCurrent=true`)
    - read-only credential için admin API deny
  - `service/tests/security/ui-session-store.test.ts`
    - hashed session persistence restore
    - session inventory + bulk revoke davranışı
  - `service/tests/security/audit-log.test.ts`
    - sanitized audit persistence restore

## Çalıştırılan Verification Komutları
| Komut | Sonuç | Kanıt |
|---|---|---|
| `npm run typecheck` | ✅ | TS hata yok |
| `npm test -- --runInBand` | ✅ | **124/124 test geçti** |
| `npm audit --omit=dev` | ✅ | 0 vulnerability |
| `npx tsx -e "...ui session admin smoke..."` | ✅ | `list=200`, `revoke=200` |
| `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` | ✅ | PASS |

## Bu Koşumdaki Yeni Testler
- `service/tests/contract/ui-sessions.test.ts` ✅
  - `GET /v1/ui/sessions`
  - `POST /v1/ui/sessions/:sessionId/revoke`
  - `POST /v1/ui/sessions/revoke-all`
  - read-only scope için admin deny
- `service/tests/security/ui-session-store.test.ts` güncellendi ✅
  - hashed persistence restore
  - session inventory + bulk revoke
- `service/tests/security/audit-log.test.ts` güncellendi ✅
  - sanitized persistence restore

## Regresyon Durumu
- MCP resilience/persistence regresyonu yok
- Mevzuat/Borsa/Yargı MCP adapter akışı regresyonsuz
- RAG + Memory + QMD + Financial akışları regresyonsuz

## Sonuç
UI auth katmanı kısa ömürlü session token modeline geçirildi; test paketi tamamen yeşil.
## 2026-03-17 Ek doğrulama (risk kapatma)
- `npm run typecheck` ✅
- `npm test` ✅ (64/64)
- `npm audit --omit=dev` ✅ (0 vulnerability)
- `bash scripts/delivery-gate.sh projects/SMART-AI` ✅ PASS
- Yeni testler:
  - `/ui/session/revoke` invalidation senaryosu
  - `/ui/session` brute-force lock (429 + retry-after)
  - `ui-session-store` revoke testi
  - MCP persistence factory fallback testi

## 2026-03-17 Cross-repo adaptasyon doğrulaması
- `npm run typecheck` ✅
- `npm test` ✅ (66/66)
- `npm audit --omit=dev` ✅ (0 vulnerability)
- `bash scripts/delivery-gate.sh projects/SMART-AI` ✅ PASS
- Yeni testler:
  - `tests/orchestrator/planner.test.ts` (stage checklist üretimi)
  - `tests/memory/memory-service.test.ts` içinde related memory links testi

## 2026-03-18 Ek doğrulama (production key fail-fast)
- `npm run typecheck` ✅
- `npm test` ✅ (**69/69**)
- `npm audit --omit=dev` ✅ (0 vulnerability)
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` ✅ PASS
- Yeni testler:
  - `service/tests/security/config-master-key.test.ts`
    - development modda fallback master key kabulü
    - production modda missing `MASTER_KEY_BASE64` için fail-fast
    - production modda geçersiz/short `MASTER_KEY_BASE64` için fail-fast

## 2026-03-18 Ek doğrulama (security telemetry + dashboard hardening)
- `npm run typecheck` ✅
- `npm test` ✅ (**80/80**)
- `npm audit --omit=dev` ✅ (0 vulnerability)
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` ✅ PASS
- Yeni testler:
  - `service/tests/contract/security-events.test.ts`
    - tenant-scope security event feed
    - type filter doğrulaması
  - `service/tests/security/audit-log.test.ts`
    - bounded tenant event retention
    - type/since filtreleme
  - `service/tests/security/origin-guard.test.ts`
    - allowlist enforcement + malformed origin reject
  - `service/tests/contract/ui.test.ts` güncellendi
    - CSP ve güvenlik header doğrulaması
    - invalid tenant format rejection
    - UI origin allowlist block/allow senaryoları
  - `service/tests/contract/models.test.ts` güncellendi
    - invalid tenant header rejection

## 2026-03-19 Ek doğrulama (OpenBB native tool integration)
- `npm run typecheck` ✅
- `npm test` ✅ (**85/85**)
- `npm audit --omit=dev` ✅ (0 vulnerability)
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` ✅ PASS
- Yeni testler / güncellemeler:
  - `service/tests/tools/openbb-search.test.ts`
    - ticker parser doğrulaması
    - OPENBB disabled davranışı
    - quote/historical/company+world news birleşik özet doğrulaması
  - `service/tests/orchestrator/planner.test.ts` güncellendi
    - trading/OpenBB sorgusunda `openbb_search` route doğrulaması
  - `service/tests/orchestrator/verifier.test.ts` güncellendi
    - trading data sorgusunda `openbb_search` öneri doğrulaması
  - `service/tests/security/policy.test.ts` güncellendi
    - `openbb_search` default policy allowlist doğrulaması
  - `service/tests/tools/deep-research.test.ts` güncellendi
    - OpenBB dependency stublarıyla derleme/regresyon doğrulaması

## 2026-03-19 Ek doğrulama (Async research lifecycle + security hardening)
- `npm run typecheck` ✅
- `npm test` ✅ (**95/95**)
- `npm audit --omit=dev` ✅ (0 vulnerability)
- `npx tsx -e "...smoke create/list/cancel..."` ✅ (`create=202`, `list=200`, `cancel=200`)
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` ✅ PASS
- Yeni testler:
  - `service/tests/contract/jobs.test.ts`
    - idempotent replay (aynı payload/key)
    - idempotency conflict (aynı key + farklı payload)
    - active-job cap (`429`)
    - list + cancel lifecycle
    - invalid `Idempotency-Key` doğrulaması
  - `service/tests/worker/jobs.test.ts`
    - store-level idempotency davranışı
    - tenant active-job sınırı
    - cancel-after-runner-complete race koruması
    - sensitive error redaction doğrulaması

## 2026-03-20 Ek doğrulama (Security intelligence summary + header abuse hardening)
- `npm run typecheck` ✅
- `npm test` ✅ (**101/101**)
- `npm audit --omit=dev` ✅ (0 vulnerability)
- `PORT=18080 ... npm run dev + curl /health + curl /v1/security/summary` ✅ smoke başarılı
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` ✅ PASS
- Yeni testler / güncellemeler:
  - `service/tests/contract/security-events.test.ts`
    - `GET /v1/security/summary` contract doğrulaması
    - oversized `Authorization` header için `431` doğrulaması
  - `service/tests/security/audit-log.test.ts`
    - audit detail redaction doğrulaması
    - risk summary + top IP + flag üretimi doğrulaması
  - `service/tests/contract/ui.test.ts`
    - `/ui/session` oversized API key payload reddi (`400`)
    - `/ui/session/revoke` oversized authorization header reddi (`431`)

## 2026-03-21 Ek doğrulama (Async runtime cancellation + model allowlist hardening)
- `npm run typecheck` ✅
- `npm test` ✅ (**99/99**)
- `npm audit --omit=dev --audit-level=high` ✅ (0 vulnerability)
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` ✅ PASS
- Yeni testler / güncellemeler:
  - `service/tests/contract/chat-completions.test.ts`
    - allowlist dışı model için `403` doğrulaması
  - `service/tests/contract/jobs.test.ts`
    - allowlist dışı model ile async job reject (`403`)
  - `service/tests/worker/jobs.test.ts`
    - running job timeout/cancel reason doğrulaması
    - idempotency TTL expiry/prune davranışı doğrulaması

## 2026-03-24 Ek doğrulama (Tenant model policy + fail-closed enforcement)
- `./node_modules/.bin/tsc --noEmit` ✅
- `./node_modules/.bin/tsx --test "tests/**/*.test.ts"` ✅ (**113/113**)
- `APP_API_KEYS=smoke-key ... ./node_modules/.bin/tsx -e "...model policy + chat + models smoke..."` ✅ (`put=200`, `chat=200`, `models=200`, `selectedModel=openai/gpt-4o-mini`)
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` ✅ PASS
- `npm audit --omit=dev --audit-level=high` ⚠️ Çalıştırılamadı: host npm kurulumu `semver` modülü eksik olduğu için process başlatamıyor.
- Yeni testler / güncellemeler:
  - `service/tests/contract/model-policy.test.ts`
    - effective deployment default policy contract doğrulaması
    - tenant allowlist daraltma + `/v1/models` yansıması
    - deployment dışı model reject (`403`)
    - reset → deployment defaults dönüşü
  - `service/tests/contract/chat-completions.test.ts`
    - model alanı olmadan tenant default model seçimi doğrulaması
  - `service/tests/contract/jobs.test.ts`
    - async research job için tenant default model fallback doğrulaması
  - `service/tests/security/model-policy.test.ts`
    - stale/invalid tenant policy için fail-closed davranışı
    - effective allowed model kalmadığında request reject doğrulaması
  - `service/tests/contract/models.test.ts`
    - `/v1/models` meta.default_model + source doğrulaması

## 2026-03-22 Ek doğrulama (UI session rotation + lifecycle hardening)
- `npm run typecheck` ✅
- `npm test` ✅ (**104/104**)
- `npm audit --omit=dev --audit-level=high` ✅ (0 vulnerability)
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` ✅ PASS
- Yeni testler / güncellemeler:
  - `service/tests/contract/ui.test.ts`
    - `GET /ui/session` metadata contract doğrulaması
    - `POST /ui/session/refresh` token rotation + old-token invalidation doğrulaması
  - `service/tests/security/ui-session-store.test.ts`
    - rotate davranışı
    - tenant session-cap eviction (oldest token drop)
    - user-agent binding mismatch reject
    - idle-timeout expiry doğrulaması

## 2026-03-25 Ek doğrulama (Scoped auth + UI origin binding)
- `npm run typecheck` ✅
- `npm test` ✅ (**118/118**)
- `npx tsx --test tests/contract/auth-context.test.ts` ✅ (**5/5**)
- `npm audit --omit=dev` ✅ (0 vulnerability)
- `/root/.openclaw/workspace-yazilimci/scripts/delivery-gate.sh /root/.openclaw/workspace-yazilimci/projects/SMART-AI` ✅ PASS
- Yeni testler / güncellemeler:
  - `service/tests/contract/auth-context.test.ts`
    - `GET /v1/auth/context` principal/scope contract doğrulaması
    - read-only credential için operate deny + audit feed görünürlüğü
    - operate credential için admin-only route deny doğrulaması
    - UI session scope inheritance + unsafe `/v1/*` origin binding doğrulaması
    - admin credential için protected key/model-policy route erişimi
  - `service/tests/security/ui-session-store.test.ts`
    - rotation sonrası principal/scopes korunumu doğrulaması
