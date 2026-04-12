# SMART-AI — OpenRouter Agentic Intelligence API

OpenRouter tabanlı modelleri ajan orkestrasyonu + tool kullanımı ile güçlendirip **OpenAI-compatible API** olarak sunan servis.

## Vizyon
Ham LLM çağrısı yerine:
- Planlayan (Planner)
- Tool kullanan (Executor)
- Kanıtı kontrol eden (Verifier)
- Cevabı sentezleyen (Synthesizer)

bir akış ile daha güvenilir ve araştırmacı bir zeka katmanı sağlanır.

## Öne Çıkanlar
- OpenAI-compatible endpointler (`/v1/models`, `/v1/chat/completions`)
- Tenant bazlı güvenlik (`Authorization` + `x-tenant-id`)
- **Scoped API key registry + auth context introspection** (`APP_API_KEY_DEFINITIONS` + `/v1/auth/context`)
- Tenant bazlı OpenRouter API key saklama (AES-256-GCM encrypted-at-rest)
- Policy kontrollü tool erişimi
- Sync chat + Async research jobs (`/v1/jobs/research`) + job list/cancel lifecycle (`/v1/jobs`, `/v1/jobs/:jobId/cancel`)
- Stream/non-stream cevap desteği
- **RAG knowledge base** (tenant izole ingest + retrieval)
- **Remote source policy control plane** (`/v1/rag/remote-policy`, secure-by-default `preview_only`, per-tenant allowlist/open/disabled overrides)
- **Secure remote RAG URL preview + ingest hardening** (`/v1/rag/url-preview`, SSRF/private-network guardrails, redirect revalidation, MIME/size/timeout limits, audit telemetry)
- **Brave Search destekli web_search** (fallback: DuckDuckGo)
- **Verifier kalite kapıları** (minimum citation + source diversity + failure-signal reliability kontrolü)
- **Clean LLM answer mode** (kaynak listesi varsayılan olarak kapalı; sadece talep edilince eklenir)
- **Loop guard** (tekrarlayan tool-pass kırıcı)
- **Deep research budget/concurrency kontrolleri**
- **Research job runtime hardening** (Idempotency-Key TTL + tenant active-job cap + AbortSignal destekli gerçek cancel/timeout + cancellation reason telemetry)
- **Model allowlist policy** (`OPENROUTER_ALLOWED_MODELS` + model format doğrulaması + security audit event)
- **Tenant model policy override** (`/v1/model-policy` ile per-tenant allowlist + default model + fail-closed invalid policy handling)
- **Tenant Memory Layer** (memorizasyon + retrieval + auto-capture)
- **QMD Local Search entegrasyonu** (VPS'teki kurulu `qmd` ile proje doküman araması)
- **Memory hotness scoring + retrieval telemetry** (OpenViking pattern)
- **OpenBB native tool entegrasyonu** (`openbb_search`: equity quote/historical + company/world news)
- **OpenBB-inspired financial provider fallback** (Stooq + AlphaVantage quote harmonization)
- **Türk domain MCP entegrasyonu** (Mevzuat MCP + Borsa MCP + Yargı MCP via mcporter)
- **MCP Dayanıklılık Katmanı** (circuit breaker + adaptive timeout + kalıcı health snapshot + health endpointleri)
- **Security Audit Event Feed** (`/v1/security/events`) + dashboard güvenlik olay görünürlüğü
- **Security Risk Summary** (`/v1/security/summary`) + tenant bazlı risk skoru / alarm bayrakları
- **Tamper-evident + signed Security Export** (`/v1/security/export`, `/v1/security/export/verify`) + hash-chain integrity + Ed25519 bundle signature doğrulaması
- **Security Export Signing Registry** (`GET/POST /v1/security/export/keys*` + `/.well-known/smart-ai/security-export-keys.json`) + active/verify-only key rotation + public JWKS discovery
- **Dedicated Security Export Delivery Egress Policy** (`GET/PUT/DELETE /v1/security/export/delivery-policy` + `POST /v1/security/export/deliveries/preview`) + separate delivery control plane + host/path-prefix allowlist + target preview + pinned-address visibility
- **Resilient Security Export Delivery Queue** (`POST /v1/security/export/deliveries` with `mode=async`) + encrypted retry payload store + backoff/dead-letter lifecycle + Idempotency-Key dedupe + Ed25519 delivery headers
- **Security Export Delivery Incident Workflow** (`GET /v1/security/export/delivery-incidents`, `POST /v1/security/export/delivery-incidents/:incidentId/{acknowledge|clear-request|clear}`) + operator ack + live canary-backed clear request + four-eyes clear approval + revision/audit trail
- **Security Export Operator Roster RBAC** (`GET/PUT/DELETE /v1/security/export/operator-policy`) + tenant-scoped incident commander / recovery requester / recovery approver ayrımı + fail-closed explicit roster enforcement
- **Incident-Revision Scoped Security Export Delegation Approval** (`POST /v1/security/export/operator-delegations`, `POST /v1/security/export/operator-delegations/:grantId/approve`) + pending approval lifecycle + fresh-session step-up + stale/reopened incident fail-closed rejection + delegated recovery audit trail
- **Security Export Delivery Analytics + Auto-Quarantine** (`GET /v1/security/export/delivery-analytics`) + destination health verdictleri + repeated-failure quarantine + fail-closed preview/enqueue/redrive guard + clearable/unacked incident visibility
- **Header abuse guard** (Authorization / tenant header boyut limitleri + UI oversized key koruması)
- **UI session lifecycle hardening** (`/ui/session` introspection + `/ui/session/refresh` token rotation + idle-timeout + session cap eviction + unsafe `/v1/*` writes için Origin binding)
- **Persistent security control plane** (hashed UI session restore + kalıcı security audit evidence + tenant admin session inventory/revoke-all)

## Klasörler
- `contracts/` → API sözleşmeleri
- `service/api/` → gateway, middleware, routes
- `service/orchestrator/` → planner/executor/verifier/synthesizer (+ stage checklist metadata)
- `service/tools/` → web/wiki/deep-research/financial/openbb/rag/memory/qmd/mcp adapters
- `service/rag/` → ingest/chunk/retrieval/runtime store
- `service/memory/` → memory ingest/retrieve/decision/auto-capture
- `service/security/` → key-store, policy, budget
- `service/worker/` → async job runtime
- `service/tests/` → contract + security + unit testleri
- `service/web/` → control dashboard + chatbot UI statik frontend

## Hızlı Başlangıç
```bash
cd service
cp .env.example .env
npm install
npm run typecheck
npm test
npm run dev
```

## Auth Header’ları
Her `/v1/*` isteğinde:
- `Authorization: Bearer <APP_API_KEYS veya APP_API_KEY_DEFINITIONS içinde tanımlı key>`
- `x-tenant-id: <tenant-id>`

### Scope modeli
- `tenant:read` → tüm `GET /v1/*` endpointleri + dashboard gözlem ekranları
- `tenant:operate` → tenant veri/işlem yazıları (`/v1/chat/completions`, `/v1/memory/*`, `/v1/rag/*`, async research job çağrıları)
- `tenant:admin` → hassas yönetim yüzeyleri (`/v1/model-policy`, `/v1/rag/remote-policy`, `/v1/keys/openrouter*`, `/v1/mcp/reset`, `/v1/mcp/flush`, `/v1/ui/sessions*`)

`tenant:admin`, otomatik olarak `tenant:operate` ve `tenant:read` yetkilerini de içerir.

Örnek `APP_API_KEY_DEFINITIONS`:
```json
[
  { "name": "dashboard-ro", "key": "dashboard-read-key", "scopes": ["tenant:read"] },
  { "name": "tenant-ops", "key": "tenant-ops-key", "scopes": ["tenant:read", "tenant:operate"] },
  { "name": "tenant-admin", "key": "tenant-admin-key", "scopes": ["tenant:admin"] }
]
```

## Tenant OpenRouter Key Kaydı
```bash
curl -X POST http://127.0.0.1:8080/v1/keys/openrouter \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a' \
  -H 'content-type: application/json' \
  -d '{"apiKey":"sk-or-v1-..."}'
```

## RAG URL Preview (safe inspect before ingest)
```bash
curl -X POST http://127.0.0.1:8080/v1/rag/url-preview \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a' \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/docs"}'
```

Yanıt; normalized/final URL, redirect zinciri, content-type, byte boyutu, `policy.mode`, `policy.allowed_for_ingest`, `policy.matched_host_rule` ve ingest öncesi güvenli snippet döner.

## Remote Source Policy
```bash
curl http://127.0.0.1:8080/v1/rag/remote-policy \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a'

curl -X PUT http://127.0.0.1:8080/v1/rag/remote-policy \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a' \
  -H 'content-type: application/json' \
  -d '{"mode":"allowlist_only","allowedHosts":["example.com","*.cdn.example.com"]}'
```

Yeni remote source policy katmanı secure-by-default gelir:
- `preview_only` → preview serbest, ingest kapalı
- `allowlist_only` → ingest yalnızca explicit allowlist hostlarında açık
- `open` → legacy davranış; tüm public-safe URL’ler ingest edilebilir
- `disabled` → preview + ingest kapalı

## RAG Belge Ingest
```bash
curl -X POST http://127.0.0.1:8080/v1/rag/documents \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a' \
  -H 'content-type: application/json' \
  -d '{
    "documents": [
      {
        "title": "SMART-AI API",
        "content": "Chat endpoint /v1/chat/completions ..."
      }
    ]
  }'
```

Remote URL ingest aynı endpoint üzerinden yapılır; artık credentials içeren URL’ler, localhost/private/link-local hedefler, allowlist dışı portlar, şüpheli redirect hop’ları ve allowlist dışı MIME tipleri fail-closed reddedilir. Varsayılan `preview_only` modunda ingest kapalıdır; tenant admin gerekli hostları allowlist’e ekleyip `allowlist_only` veya `open` moduna geçmeden URL ingest çalışmaz.

## RAG Search
```bash
curl -X POST http://127.0.0.1:8080/v1/rag/search \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a' \
  -H 'content-type: application/json' \
  -d '{"query":"chat completions endpoint"}'
```

## Secure Remote RAG URL Preview
```bash
curl -X POST http://127.0.0.1:8080/v1/rag/url-preview \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a' \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/docs"}'
```

Bu endpoint, ingest öncesi URL’nin güvenli olup olmadığını doğrular ve `final_url`, `redirects`, `content_type`, `content_length_bytes`, `excerpt` alanlarıyla operatöre kontrollü bir önizleme verir.

## Remote URL ile RAG Ingest
```bash
curl -X POST http://127.0.0.1:8080/v1/rag/documents \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a' \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/docs"}'
```

Remote URL ingest akışı; localhost/private IP/link-local hedefleri, credential gömülü URL’leri, güvenli olmayan redirect zincirlerini, allowlist dışı MIME türlerini ve boyut limiti aşan cevapları fail-closed şekilde reddeder. `allowlist_only` modunda exact host/IP veya `*.example.com` wildcard kuralları dışında ingest açılmaz; Unicode host girişleri punycode normalize edilerek bypass denemeleri kapatılır. Bloklanan denemeler `/v1/security/events` içine audit evidence olarak yazılır.

## Memory Ingest
```bash
curl -X POST http://127.0.0.1:8080/v1/memory/items \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a' \
  -H 'content-type: application/json' \
  -d '{
    "items": [
      {
        "category": "preference",
        "content": "Ben toplantıları sabah saatlerinde yapmayı tercih ederim."
      }
    ]
  }'
```

## Memory Search
```bash
curl -X POST http://127.0.0.1:8080/v1/memory/search \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a' \
  -H 'content-type: application/json' \
  -d '{"query":"Benim toplantı tercihim neydi, hatırla"}'
```

## MCP Health (Resilience Ops)
```bash
curl http://127.0.0.1:8080/v1/mcp/health \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a'

curl -X POST http://127.0.0.1:8080/v1/mcp/flush \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a'
```

## Security Event Feed
```bash
curl 'http://127.0.0.1:8080/v1/security/events?limit=20' \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a'

curl 'http://127.0.0.1:8080/v1/security/summary?window_hours=24&top_ip_limit=5' \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a'
```

## Tamper-Evident Security Export
```bash
# son 24 saatin audit bundle'ını export et (admin scope gerekli)
curl 'http://127.0.0.1:8080/v1/security/export?limit=500&since=2026-03-29T00:00:00.000Z' \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a'

# dış sisteme taşınan signed bundle'ın hash-chain + signature doğrulamasını tekrar yap
curl -X POST 'http://127.0.0.1:8080/v1/security/export/verify' \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a' \
  -H 'content-type: application/json' \
  -d @security-export-bundle.json

# aktif export signing key registry + public JWKS keşfi
curl 'http://127.0.0.1:8080/v1/security/export/keys' \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a'

curl 'http://127.0.0.1:8080/.well-known/smart-ai/security-export-keys.json'

# signing lifecycle policy health + eşikleri gör/güncelle
curl 'http://127.0.0.1:8080/v1/security/export/signing-policy' \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a'

curl -X PUT 'http://127.0.0.1:8080/v1/security/export/signing-policy' \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a' \
  -H 'content-type: application/json' \
  -d '{"auto_rotate":true,"rotate_after_hours":720,"expire_after_hours":1080,"warn_before_hours":168,"verify_retention_hours":2160}'

# aktif signing key rotate et (önceki key verify-only kalır)
curl -X POST 'http://127.0.0.1:8080/v1/security/export/keys/rotate' \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a' \
  -H 'content-type: application/json' \
  -d '{}'

# signing maintenance leader/lease/history durumunu gör
curl 'http://127.0.0.1:8080/v1/security/export/signing-maintenance' \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a'

# manual maintenance dry-run / execute
curl -X POST 'http://127.0.0.1:8080/v1/security/export/signing-maintenance/run' \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a' \
  -H 'content-type: application/json' \
  -d '{"dry_run":true}'

curl -X POST 'http://127.0.0.1:8080/v1/security/export/signing-maintenance/run' \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a' \
  -H 'content-type: application/json' \
  -d '{}'

# dedicated delivery-egress policy'yi host+path seviyesinde tanımla
curl -X PUT 'http://127.0.0.1:8080/v1/security/export/delivery-policy' \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a' \
  -H 'content-type: application/json' \
  -d '{"mode":"allowlist_only","allowedTargets":["siem.example.com/hooks/smart-ai","https://logs.example.com/v1/tenants/tenant-a"]}'

# gerçek gönderim yapmadan hedefi preview et
curl -X POST 'http://127.0.0.1:8080/v1/security/export/deliveries/preview' \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a' \
  -H 'content-type: application/json' \
  -d '{"destinationUrl":"https://siem.example.com/hooks/smart-ai?token=hidden"}'

# tek denemelik sync delivery
curl -X POST 'http://127.0.0.1:8080/v1/security/export/deliveries' \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a' \
  -H 'content-type: application/json' \
  -d '{"destinationUrl":"https://siem.example.com/hooks/smart-ai","mode":"sync","windowHours":24,"limit":500}'

# retry/backoff + dead-letter ile async resilient delivery
curl -X POST 'http://127.0.0.1:8080/v1/security/export/deliveries' \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a' \
  -H 'Idempotency-Key: sec-export-2026-03-31-01' \
  -H 'content-type: application/json' \
  -d '{"destinationUrl":"https://siem.example.com/hooks/smart-ai","mode":"async","windowHours":24,"limit":500}'

# retry/dead-letter durumlarını filtrele
curl 'http://127.0.0.1:8080/v1/security/export/deliveries?status=dead_letter&limit=20' \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a'

# delivery analytics + quarantine görünürlüğü
curl 'http://127.0.0.1:8080/v1/security/export/delivery-analytics?window_hours=24&bucket_hours=6&destination_limit=8' \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a'
```

Export bundle'ı artık sıralı `sequence`, `prev_chain_hash`, `chain_hash` alanlarıyla birlikte **Ed25519 signature metadata** taşır. Böylece SIEM/forensics hattı, payload transfer sonrası bile bundle üzerinde hem server-side hash-chain bütünlüğü hem de detached signature doğrulaması yapabilir. Public verification için `/.well-known/smart-ai/security-export-keys.json` JWKS endpointi yayınlanır ve signing key rotation geçmişi verify-only anahtarlarla korunur.

Export signing hattı artık lifecycle-aware çalışır: admin kullanıcı `/v1/security/export/signing-policy` ile auto-rotate, expiry, warn window ve verify-only retention eşiklerini yönetebilir. Active key rotate süresi dolduğunda yeni export imzalanmadan önce otomatik anahtar üretilebilir; auto-rotation kapalıysa expired key ile export/delivery istekleri fail-closed reddedilir. Verify-only anahtarlar retention süresi dolunca JWKS yüzeyinden prune edilir ve `/v1/security/summary` ile dashboard signing health/alert görünürlüğü sağlar.

Yeni maintenance control plane ile `/v1/security/export/signing-maintenance` ve `/v1/security/export/signing-maintenance/run` endpointleri leader lease, son maintenance history ve admin dry-run/execute akışını expose eder. Shared store refresh + lease tabanlı maintenance sayesinde aynı signing store'u paylaşan çoklu instance'lar stale active key ile devam etmez; yalnızca leader instance auto-rotate/prune mutasyonlarını yazar, diğer instance'lar ise store'u rehydrate ederek güncel active key'i kullanır.

Security export delivery hattı production-grade operasyon için dört ek güvenlik/direnç katmanı sağlar:
- delivery egress allowlist artık remote source policy’den ayrıdır; dedicated `delivery-policy` control plane ile **host + path-prefix** seviyesinde yönetilir,
- `preview` endpoint’i gerçek gönderim yapmadan `allowed/reason/matched_rule/pinned_address` verdict’i döndürür,
- retry queue payload'ı düz JSON değil, AES-256-GCM ile encrypted-at-rest saklanır,
- `Idempotency-Key` ile aynı export isteğinin duplicate/replay flood'u bastırılır; retryable ağ/5xx/429 hataları backoff ile tekrar denenir, limit aşılırsa receipt `dead_letter` olur ve `/v1/security/events` içinde kanıt bırakır.
- `GET /v1/security/export/delivery-analytics` son pencere için success-rate, status dağılımı, incident timeline ve destination health verdict’lerini (`healthy|degraded|quarantined`) expose eder.
- aynı tenant içindeki aynı destination tekrar tekrar terminal failure/dead-letter üretirse hedef otomatik quarantine durumuna girer; preview, sync delivery, async enqueue ve manual redrive akışları fail-closed bloke edilir.
- `GET /v1/security/export/delivery-incidents`, `POST /v1/security/export/delivery-incidents/:incidentId/acknowledge`, `POST /v1/security/export/delivery-incidents/:incidentId/clear` ile quarantine incident’ları operator ownership + revision guard + zorunlu açıklama modeliyle yönetilir; süre dolsa bile manual clear olmadan hedef tekrar açılmaz.
- `GET/PUT/DELETE /v1/security/export/operator-policy` ile tenant bazlı operator roster yönetilir; `roster_required` modunda acknowledge, clear-request ve clear approval adımları ayrı principal listelerine bağlanır ve yetkisiz admin denemeleri audit event ile fail-closed reddedilir.
- `POST /v1/security/export/operator-delegations` artık doğrudan aktif grant yerine `pending_approval` request üretir; `POST /v1/security/export/operator-delegations/:grantId/approve` ikinci operatör onayı ile grant'i aktive eder.
- Delegation create/approve/revoke mutasyonlarında dashboard oturumu için fresh-session step-up zorunludur; taze olmayan UI session fail-closed reddedilir, API key admin akışı desteklenir.
- Pending delegation request'leri approval TTL ile sınırlandırılır; requester kendi talebini, delegate principal ise kendi grant'ini approve edemez.

## Auth Context Introspection
```bash
curl http://127.0.0.1:8080/v1/auth/context \
  -H 'Authorization: Bearer dashboard-read-key' \
  -H 'x-tenant-id: tenant-a'
```

Bu endpoint, aktif credential’ın hangi principal adına çalıştığını ve hangi scope’lara sahip olduğunu döner. Dashboard ve Chat UI bu endpoint’i kullanarak admin/operate kontrollerini otomatik olarak salt-okunur moda alır.

## Web UI (Control Dashboard + Chat UI)
Sunucu kalktıktan sonra:
- `http://127.0.0.1:8080/ui/dashboard`
- `http://127.0.0.1:8080/ui/chat`

UI, API Key ve Tenant ID ile `POST /ui/session` üzerinden kısa ömürlü oturum tokenı üretir. API key tarayıcıda kalıcı saklanmaz; `/v1/*` çağrıları session token + tenant header ile yapılır.

Yeni güvenlik akışı:
- `/ui/session` endpoint’inde brute-force koruması (IP+tenant bazlı geçici lock)
- `GET /ui/session` ile aktif session introspection (expiry + idle timeout görünürlüğü)
- `POST /ui/session/refresh` ile token rotation (eski token anında geçersizleşir)
- `POST /ui/session/revoke` ile aktif token revoke/logout desteği
- UI session’lar için idle-timeout enforcement + User-Agent fingerprint kontrolü uygulanır
- Tenant/global session cap ile eski tokenlar otomatik evict edilir (memory DoS riskine karşı)
- Login hata mesajı normalize edilmiştir (`Invalid credentials`).
- UI state-changing endpoint’lerde Origin allowlist kontrolü (`UI_ALLOWED_ORIGINS`) desteklenir.
- UI session token’ı ile yapılan state-changing `/v1/*` çağrıları da allowlisted Origin’e bağlanır; eksik/şüpheli origin 403 ile reddedilir.
- `/ui/dashboard` ve `/ui/chat` yanıtlarında CSP + güvenlik header’ları uygulanır.
- Dashboard artık API key’i localStorage’da tutmaz; chat ile aynı kısa ömürlü session token modeli kullanılır.
- Dashboard ve Chat UI, token bitişine yakın otomatik `refresh` çağırarak kesintisiz oturum yeniler.
- Dashboard ve Chat UI, `/v1/auth/context` ile scope farkındalığı kazanır; admin/operate yetkisi yoksa ilgili kontroller otomatik disable edilir.
- Dashboard, tenant model policy’yi okuyup güncelleyebilir; Chat UI varsayılan tenant modelini otomatik seçer.
- Dashboard, `/v1/security/summary` ile 24h risk seviyesi + alarm bayraklarını da gösterir.
- Dashboard, dedicated delivery-egress policy plane’i (`/v1/security/export/delivery-policy`) yönetir ve export hedeflerini gerçek gönderimden önce preview edebilir.
- UI session ve security audit state artık restart sonrası korunur; session token plaintext halde değil yalnızca hash+metadata olarak saklanır.
- `GET /v1/ui/sessions`, `POST /v1/ui/sessions/:sessionId/revoke` ve `POST /v1/ui/sessions/revoke-all` ile admin kullanıcı tenant içindeki aktif web oturumlarını yönetebilir.
- Dashboard, mevcut oturumu düşürmeden “Diğer Oturumları Kapat” aksiyonu ile güvenli incident-response akışı sunar.

UI session lifecycle endpoint örnekleri:
```bash
# aktif session metadata
curl http://127.0.0.1:8080/ui/session \
  -H 'Authorization: Bearer <ui-session-token>' \
  -H 'x-tenant-id: tenant-a'

# token rotate/refresh
curl -X POST http://127.0.0.1:8080/ui/session/refresh \
  -H 'Authorization: Bearer <ui-session-token>' \
  -H 'x-tenant-id: tenant-a'

# tenant içindeki aktif web oturumlarını listele (admin)
curl http://127.0.0.1:8080/v1/ui/sessions \
  -H 'Authorization: Bearer <ui-session-token-or-admin-key>' \
  -H 'x-tenant-id: tenant-a'

# tek bir session kapat
curl -X POST http://127.0.0.1:8080/v1/ui/sessions/<session-id>/revoke \
  -H 'Authorization: Bearer <ui-session-token-or-admin-key>' \
  -H 'x-tenant-id: tenant-a' \
  -H 'Origin: https://dashboard.example.com'

# mevcut session açık kalırken diğerlerini kapat
curl -X POST http://127.0.0.1:8080/v1/ui/sessions/revoke-all \
  -H 'Authorization: Bearer <ui-session-token-or-admin-key>' \
  -H 'x-tenant-id: tenant-a' \
  -H 'Origin: https://dashboard.example.com' \
  -H 'content-type: application/json' \
  -d '{"exceptCurrent":true}'
```

## QMD Collection Bootstrap (opsiyonel manuel)
```bash
# service dizininden bir üstte proje kökü varsayılır
cd ..
qmd collection add . --name SMART-AI
qmd search "memory endpoint" -c SMART-AI --json -n 5
```

## Tenant Model Policy
```bash
# effective policy görüntüle
curl http://127.0.0.1:8080/v1/model-policy \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a'

# tenant için daha dar güvenli model kümesi tanımla
curl -X PUT http://127.0.0.1:8080/v1/model-policy \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a' \
  -H 'content-type: application/json' \
  -d '{
    "defaultModel":"openai/gpt-4o-mini",
    "allowedModels":["openai/gpt-4o-mini","deepseek/deepseek-v3.2"]
  }'
```

## Chat Completion
```bash
# model alanı opsiyoneldir; tenant default model otomatik uygulanır.
curl -X POST http://127.0.0.1:8080/v1/chat/completions \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a' \
  -H 'content-type: application/json' \
  -d '{
    "messages":[{"role":"user","content":"NVDA son bilanço etkisini analiz et"}],
    "stream": false
  }'
```

## Async Deep Research Job
```bash
# job başlat (idempotent)
curl -X POST http://127.0.0.1:8080/v1/jobs/research \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a' \
  -H 'Idempotency-Key: ai-research-2026-03-19-01' \
  -H 'content-type: application/json' \
  -d '{"query":"Türkiye AI ekosisteminin 2025 trendlerini karşılaştırmalı analiz et"}'

# job listesi
curl 'http://127.0.0.1:8080/v1/jobs?limit=20&status=running' \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a'

# job durumunu al
curl http://127.0.0.1:8080/v1/jobs/<job_id> \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a'

# çalışan/queued job iptal et
curl -X POST http://127.0.0.1:8080/v1/jobs/<job_id>/cancel \
  -H 'Authorization: Bearer dev-admin-key' \
  -H 'x-tenant-id: tenant-a'
```

## Referans Esin Kaynakları
- CrewAI (plan/execute, MCP patterns)
- OpenRAG (ingest + retrieval çalışma modeli)
- Open Deep Research (workflow + araştırma akışı yaklaşımı)
- Qwen-Agent (tool-call + runtime patternleri)
- Deer-Flow (stability middleware patternleri)
- memU (memory/retrieval decision yaklaşımı)
- OpenViking (memory hotness + retrieval stats pattern)
- OpenClaw (qmd process/manager + fallback safety pattern)
- Cognee (memory graph retrieval/memify patternleri)
- QMD (lokal markdown index + hızlı arama)
- OpenBB (provider registry/fetcher lifecycle ile finansal tool hardening)
- saidsurucu/mevzuat-mcp (Türk mevzuat MCP entegrasyonu)
- saidsurucu/borsa-mcp (BIST/TEFAS/KAP MCP entegrasyonu)
- saidsurucu/yargi-mcp (Türk yargı/emsal karar MCP entegrasyonu)
