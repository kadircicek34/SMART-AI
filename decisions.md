# DECISIONS — OpenRouter Agentic Intelligence API

## 2026-03-16 — Mimari yaklaşım seçimi
### Problem
Bu proje hızlı teslim + ürünleşebilir kalite + uzun görev desteğini aynı anda sağlamalı.

### Seçenekler
- A: Tek servis, senkron ağırlıklı
- B: Modüler monolith + async worker
- C: Baştan microservices

### Karar
**B seçildi:** Modüler monolith + async worker.

### Gerekçe
- MVP hızını korurken uzun görevleri izole eder.
- Güvenlik/policy katmanını net sınırlarla tutar.
- Gerektiğinde microservice'e evrilmeye izin verir.

### Etki
- İlk sürümde operasyonel karmaşıklık orta seviyede olur.
- Uzun araştırma akışları API threadlerini bloklamaz.

### Bilinçli Olarak Ertelenenler
- Baştan tam microservice parçalanması
- RL training pipeline entegrasyonu

### Tekrar Değerlendirme Tetikleri
- Eşzamanlı tenant yükü hızla artarsa
- Async job hacmi API katmanını zorlamaya başlarsa

---

## 2026-03-16 — Reuse stratejisi
### Problem
4 referans projeden nasıl yararlanılacağı netleşmeli (kopya mı, sentez mi?).

### Seçenekler
- Doğrudan kod kopyası
- Pattern-level sentez + temiz implement

### Karar
**Pattern-level sentez + temiz implement** seçildi.

### Gerekçe
- Lisans/güvenlik/bağımlılık riskini düşürür.
- Ürün ihtiyaçlarına göre daha temiz domain tasarımı sağlar.

### Etki
- Kısa vadede biraz daha implementasyon eforu gerekir.
- Uzun vadede bakım ve ölçeklenebilirlik kazanılır.

### Bilinçli Olarak Ertelenenler
- Referans repolardan birebir modül taşıma

### Tekrar Değerlendirme Tetikleri
- Lisans netliği + teknik gereksinim birebir reuse'u zorunlu kılarsa

---

## 2026-03-16 — API sözleşmesi önceliği
### Problem
İstemci entegrasyonu için ilk sabit nokta ne olmalı?

### Seçenekler
- Önce iç orkestrasyonu yazmak
- Önce dış API sözleşmesini sabitlemek

### Karar
**Önce API contract freeze**.

### Gerekçe
- Chatbot entegrasyonunu erken başlatır.
- İç mimari değişse bile istemci kırılmaz.

### Etki
- Implementasyon sırasında compatibility regresyonu azalır.

### Bilinçli Olarak Ertelenenler
- Erken dönemde geniş endpoint seti

### Tekrar Değerlendirme Tetikleri
- İstemci tarafı yeni endpoint ihtiyaçları doğurursa

---

## 2026-03-16 — RAG aktif etme kararı
### Problem
İç bilgi tabanı sorularında web tabanlı cevaplar yetersiz kalıyor, tenant-specific bilgi geri çağrımı gerekiyor.

### Seçenekler
- A: RAG yok, sadece web/wiki
- B: Tam external vector platform bağımlılığı
- C: Tenant izole, dosya tabanlı RAG çekirdeği + API

### Karar
**C seçildi:** Tenant izole, dosya tabanlı RAG çekirdeği + API endpointleri.

### Gerekçe
- Hızlı ürünleşme ve düşük operasyonel bağımlılık
- Güvenlikte tenant boundary'nin net korunması
- Sonraki sürümde vector backend'e evrilebilir mimari

### Etki
- İç doküman sorgularında kalite artışı
- Orchestrator plan/verifier akışına `rag_search` eklenmesi

---

## 2026-03-16 — Web search provider kararı (Brave + fallback)
### Problem
Web aramada kalite ve deterministik sonuç ihtiyacı var; tek sağlayıcıya bağımlılık kırılmalı.

### Seçenekler
- A: Sadece DuckDuckGo
- B: Sadece Brave
- C: Brave primary + DuckDuckGo fallback

### Karar
**C seçildi:** Brave primary, hata durumunda DuckDuckGo fallback.

### Gerekçe
- Brave ile daha zengin sonuç formatı
- Fallback ile çalışma sürekliliği
- Operasyonel kesinti riskini azaltma

### Etki
- `web_search` aracı dayanıklılığı arttı
- BRAVE_API_KEY olmayan ortamlarda mevcut davranış korunuyor

---

## 2026-03-16 — OpenRouter retry/backoff dayanıklılık kararı
### Problem
Upstream OpenRouter oran limitleri (429) ve geçici 5xx hataları kısa süreli olsa da cevap üretimini gereksiz yere başarısızlığa düşürüyor.

### Seçenekler
- A: Retry yok, tek deneme
- B: Sadece sabit gecikmeli retry
- C: Retry-After destekli, exponential backoff + jitter ile kontrollü retry

### Karar
**C seçildi:** Retry-After başlığına uyumlu, retryable status kodlarında exponential backoff + jitter.

### Gerekçe
- Geçici hatalarda başarı oranını artırır
- 429 davranışını upstream yönlendirmesine göre daha doğru yönetir
- Basit ve operasyonel olarak düşük riskli bir dayanıklılık iyileştirmesi

### Etki
- LLM çağrılarında transient failure kaynaklı hata oranı azalır
- Varsayılan model hedefi (`deepseek/deepseek-chat-v3.1`) ile günlük kullanım stabilitesi artar
- Retry parametreleri env üzerinden ayarlanabilir hale gelir

### Bilinçli Olarak Ertelenenler
- Circuit breaker + merkezi retry telemetry
- Tenant/endpoint bazlı adaptif retry politikaları

---

## 2026-03-16 — Orchestrator kalite kapıları (source diversity + loop guard + research budget)
### Problem
Araştırma akışında tekrar eden tool pass'leri, tek kaynaktan aşırı alıntı ve sınırsız query genişletmesi kaliteyi düşürebilir.

### Seçenekler
- A: Mevcut heuristik akışa dokunmamak
- B: Sadece daha fazla tool eklemek
- C: Verifier kalite kapısı + orchestrator loop guard + deep research bütçe/concurrency kontrolü

### Karar
**C seçildi:**
- Verifier için minimum citation + minimum source diversity kapısı
- Orchestrator için tekrarlayan tool-pass imza kırıcı (loop guard)
- Deep research için query budget + max concurrent research unit limiti

### Gerekçe
- Deer-Flow’daki loop/tool-stability yaklaşımını hafif bir middleware mantığıyla taşır.
- Open Deep Research’teki iteration/concurrency disiplinini ürün dostu env ayarlarına dönüştürür.
- Kaynak çeşitliliği düşük çıktılarda yanlış güven üretimini azaltır.

### Etki
- Düşük kanıtta otomatik genişletme daha kontrollü çalışır.
- Tek kaynağa dayalı cevaplar daha temkinli sentezlenir.
- Üretim yükü ve latency davranışı daha öngörülebilir olur.

---

## 2026-03-16 — Memory Layer kararı (memU pattern integration)
### Problem
Kullanıcı geçmişi, tercihleri ve profile dair sorular için yalnızca web/RAG yeterli değil; tenant bazlı konuşma hafızası gerekli.

### Seçenekler
- A: Memory katmanı eklememek
- B: Dış memory platformuna tam bağımlılık
- C: Tenant izole local memory plane + pre-retrieval decision + orchestrator memory tool

### Karar
**C seçildi:**
- `service/memory/*` altında tenant-izole memory store
- `/v1/memory/*` endpointleri
- `memory_search` tool + planner/verifier entegrasyonu
- Chat tarafında memory-worthy mesajlar için auto-capture

### Gerekçe
- memU’daki pre-retrieval decision yaklaşımıyla gereksiz retrieval çağrılarını azaltır.
- Kullanıcıya dair tercih/profil/habit bilgisini ürün içinde sürekli erişilebilir hale getirir.
- Dış bağımlılığı minimumda tutarak hızlı ürünleşme sağlar.

### Etki
- Kişiselleştirilmiş cevap kalitesi artar.
- Memory retrieval kanıtları (`memory://...`) verifier güvenine katkı sağlar.
- Tool plane daha güçlü ama policy ve tenant sınırları korunur.

### Bilinçli Olarak Ertelenenler
- Embedding tabanlı advanced memory ranker (şu an lexical + heuristic scoring)
- Memory encryption-at-rest için ayrı KMS katmanı
- Cross-tenant/global memory federasyonu

---

## 2026-03-16 — QMD local search entegrasyon kararı (OpenClaw + QMD pattern)
### Problem
Proje içi dokümanları (README/PRD/Task/Decision vb.) web aramaya göndermeden lokal ve hızlı aramak gerekiyor.

### Seçenekler
- A: Sadece mevcut `rag_search` ile ilerlemek
- B: QMD MCP/CLI ekleyip local docs arama katmanı açmak
- C: Harici hosted search servis bağımlılığı

### Karar
**B seçildi:** VPS'te kurulu `qmd` binary ile çalışan `qmd_search` tool eklendi.

### Gerekçe
- OpenClaw’daki qmd manager/process pattern’i güvenli CLI wrapper yaklaşımını doğruluyor.
- QMD'nin `search --json` çıktısı deterministik ve düşük gecikmeli.
- Lokal docs sorgularında dış web bağımlılığı azalıyor.

### Etki
- Planner/Verifier/Deep-Research pipeline artık `qmd_search` kullanabiliyor.
- Proje içi sorgularda cevap kalitesi ve kaynak doğrulanabilirliği artıyor.

### Bilinçli Olarak Ertelenenler
- `qmd query` (LLM rerank) default açılımı — şu an performans/stabilite için `qmd search` varsayılan.
- QMD index health için ayrı cron/scheduler otomasyonu.

---

## 2026-03-16 — Memory hotness + retrieval telemetry kararı (OpenViking pattern)
### Problem
Memory retrieval kalitesinde recency/frequency etkisi ve operasyonel görünürlük eksik kalıyordu.

### Seçenekler
- A: Sadece lexical skorla devam etmek
- B: Hotness scoring + retrieval metrikleri eklemek

### Karar
**B seçildi:**
- Hotness scoring (retrieval_count + recency half-life)
- Tenant retrieval telemetry (`totalQueries`, `avgLatencyMs`, `zeroResultQueries`)

### Gerekçe
- OpenViking’deki memory lifecycle yaklaşımı pratik ve düşük riskli.
- Telemetry olmadan retrieval kalitesini üretimde değerlendirmek zor.

### Etki
- Sık ve güncel memory kayıtları daha doğru sıralanıyor.
- `/v1/memory/stats` üzerinden retrieval davranışı izlenebiliyor.

---

## 2026-03-16 — Financial provider fallback kararı (OpenBB pattern)
### Problem
`financial_deep_search` tek source davranışında kırılgan kalıyor; provider hatasında finansal cevap kalitesi düşüyor.

### Seçenekler
- A: Stooq + web arama ile devam etmek
- B: OpenBB tarzı provider registry/fallback yaklaşımını finansal tool'a uyarlamak

### Karar
**B seçildi:**
- Finansal quote için çok provider fallback eklendi (`stooq` + `alpha_vantage`)
- Çok provider çıktısı için harmonization + spread analizi eklendi
- Query parser çoklu sembol desteği ile güçlendirildi

### Gerekçe
- OpenBB’de provider soyutlama ve fetcher lifecycle tasarımı sahada kendini kanıtlıyor.
- Tek kaynağa bağımlılık yerine fallback zinciri üretim dayanıklılığını artırır.
- Finansal sonuçları kaynaklar arası kıyaslayarak güvenilirlik sinyali üretir.

### Etki
- Finansal tool cevaplarında hata toleransı arttı.
- Provider farklılıkları kullanıcıya şeffaf raporlanabilir oldu (spread).
- Finansal tool test kapsamı genişledi.

---

## 2026-03-16 — MCP dayanıklılık katmanı kararı (circuit breaker + health endpoints)
### Problem
Remote MCP servislerinde geçici hata/timeout dalgalarında aynı sunucuya arka arkaya istek atılması hem yanıt süresini şişiriyor hem de kullanıcı deneyimini bozuyor; operasyonel görünürlük de sınırlı.

### Seçenekler
- A: Mevcut davranışla devam (health/circuit yok)
- B: Sadece timeout artırmak
- C: Sunucu-bazlı circuit breaker + adaptif timeout + health/reset endpointleri

### Karar
**C seçildi:**
- `service/mcp-health/*` ile global MCP circuit breaker katmanı
- `service/tools/tr-mcp-search.ts` içine success/failure telemetry ve circuit guard entegrasyonu
- `/v1/mcp/health`, `/v1/mcp/health/:serverId`, `/v1/mcp/reset` endpointleri

### Gerekçe
- Üretimde transient failure dalgalarında kontrollü degrade sağlar.
- Fallback yerine “ölç, koru, toparla” döngüsünü devreye alır.
- Ops ekibi için anlık sağlık görünürlüğü sunar.

### Etki
- Mevzuat/Borsa/Yargı MCP çağrıları daha dayanıklı hale geldi.
- Circuit-open durumda gereksiz upstream yükü engelleniyor.
- Test kapsamı yeni contract + unit testlerle genişledi.

### Bilinçli Olarak Ertelenenler
- Persisted telemetry (Prometheus/OTEL)
- Endpoint bazlı ayrı circuit profilleri

---

## 2026-03-16 — Türk domain MCP entegrasyon kararı (Mevzuat/Borsa/Yargı)
### Problem
Türkiye odaklı hukuk/finans sorgularında genel web arama yeterli kaynak doğruluğu ve yapısallık sağlamıyor.

### Seçenekler
- A: Sadece mevcut web/RAG akışında kalmak
- B: saidsurucu MCP sunucularını remote tool plane’e bağlamak

### Karar
**B seçildi:**
- `mevzuat_mcp_search`, `borsa_mcp_search`, `yargi_mcp_search` tool’ları eklendi.
- Entegrasyon `mcporter` üzerinden remote MCP call modeliyle yapıldı.
- Yargı tarafına empty-result için fallback eklendi (`search_emsal_detailed_decisions` → `search_bedesten_unified`).

### Gerekçe
- Mevzuat MCP: kanun/mevzuat sorgularında domain-specific precision sağlar.
- Borsa MCP: BIST/TEFAS/KAP odaklı local market coverage sağlar.
- Yargı MCP: emsal karar ve mahkeme içtihatlarına doğrudan erişim sağlar.

### Etki
- Planner/verifier artık hukuk/finans Türkiye bağlamında doğrudan MCP route edebiliyor.
- Deep research akışı domain MCP kaynaklarını da birleştiriyor.
- Tool plane kapsamı genişledi ama policy allowlist ile kontrol korunuyor.

### Bilinçli Olarak Ertelenenler
- MCP health check ve circuit-breaker telemetry paneli
- MCP credentials/headers için tenant bazlı gizli yönetim katmanı

---

## 2026-03-16 — MCP health persistence kararı (restart-resistant resilience)
### Problem
MCP circuit/latency metrikleri sadece process-memory’de tutulduğu için servis restart sonrası resiliency sinyalleri sıfırlanıyordu.

### Seçenekler
- A: Sadece in-memory tutmaya devam etmek
- B: Diskte snapshot persistence + startup seed restore eklemek

### Karar
**B seçildi:**
- `service/mcp-health/store.ts` ile snapshot read/write
- startup sırasında snapshot seed edilerek circuit/latency state restore
- runtime’da debounce’lu persistence scheduler
- ops için `POST /v1/mcp/flush` endpointi

### Gerekçe
- Restart sonrası tekrar ısınma (cold-start) etkisini azaltır.
- Operasyon ekiplerine daha stabil hata/trend görünürlüğü sağlar.
- Düşük karmaşıklıkla yüksek üretim etkisi üretir.

### Etki
- MCP dayanıklılık katmanı artık restart sonrası da tutarlı davranır.
- Circuit breaker state continuity iyileşti.
- Failover/fallback kararları daha hızlı ve daha doğru verilir.

---

## 2026-03-17 — Control Dashboard + Chatbot UI kararı
### Problem
API güçlü olsa da operasyonel kontrol ve son kullanıcı etkileşimi sadece API seviyesinde kalıyordu; ürün kullanılabilirliği düşüyordu.

### Seçenekler
- A: Sadece API bırakmak
- B: Hafif web control dashboard + chatbot UI eklemek

### Karar
**B seçildi:**
- `/ui/dashboard` ile operasyonel kontrol ekranı
- `/ui/chat` ile canlı chatbot arayüzü
- statik route katmanı (`service/api/routes/ui.ts`) ile server içinden servis

### Gerekçe
- Sunucu ayağa kalktıktan sonra kullanıcıya doğrudan kullanılabilir UI sağlar.
- Operasyonel metrikleri (MCP/memory/rag) tek ekranda görünür yapar.
- Harici frontend deploy bağımlılığı olmadan hızlı ürünleşme sağlar.

### Etki
- Ürün API-first + UI-ready hale geldi.
- Teknik olmayan kullanıcı için kullanım eşiği dramatik biçimde düştü.
- SRE/operasyon tarafında troubleshooting hızı arttı.

---

## 2026-03-17 — UI auth session abstraction kararı (API key localStorage kaldırma)
### Problem
Chat UI'da API key'in localStorage'da tutulması XSS veya paylaşılan cihaz senaryolarında gereksiz risk yaratıyordu.

### Seçenekler
- A: Mevcut localStorage davranışını korumak
- B: API key'i tamamen kaldırıp yalnızca backend-side login yapmak
- C: API key ile kısa ömürlü UI session token üretip /v1 çağrılarını token ile yapmak

### Karar
**C seçildi:**
- `POST /ui/session` endpointi ile API key doğrulanıp tenant-scope kısa ömürlü token üretiliyor.
- `/v1/*` auth middleware'i APP API key + UI session token kabul edecek şekilde genişletildi.
- Chat UI API key'i kalıcı saklamıyor; session token sadece `sessionStorage` içinde tutuluyor.

### Gerekçe
- Security posture'ı yükseltirken mevcut API sözleşmesini kırmaz.
- UI kullanımını basit tutar (tek adım “Oturum Aç”).
- Tenant isolation korunur (token tenant-scope doğrulaması).

### Etki
- API key'in browser persistence yüzeyi kaldırıldı.
- UI token süresi dolduğunda kontrollü re-auth akışı oluştu.
- Contract test kapsamı session issuance + tenant-scope doğrulamasıyla genişledi.

## 2026-03-17 — UI auth risk closure + MCP health shared persistence abstraction
- `/ui/session` için özel anti-bruteforce katmanı eklendi: IP+tenant bazlı başarısız giriş penceresi, geçici block ve `retry-after` header.
- Login hata mesajı `Invalid credentials.` olarak normalize edildi (input farklarından kullanıcı bilgisi sızmaması için).
- `POST /ui/session/revoke` endpoint’i eklendi; UI logout akışı bu endpoint üzerinden token revoke ediyor.
- UI session store artık token’ı plaintext map key olarak tutmuyor; SHA-256 hash key kullanıyor.
- MCP health persistence katmanı file/http modlu abstract backend’e geçirildi. `MCP_HEALTH_PERSIST_MODE=http` ile çoklu instance ortak persistence endpoint’i kullanılabiliyor; endpoint yoksa file fallback.

## 2026-03-17 — Cross-repo synthesis (MiroFish + deepagents + A-mem)
Analysis method: `mcporter` üzerinden `github-readonly` + `repomix` kullanıldı.

Uygulanan adaptasyonlar:
- **deepagents esinli plan/todo yaklaşımı**: Orchestrator planına `stages` checklist alanı eklendi (discover/domain/synthesis), metadata içinde görünür hale geldi.
- **MiroFish esinli aşamalı pipeline görünürlüğü**: Tool seçimleri aşama bazına map edilerek aşama durumları (`pending/running/done`) takip ediliyor.
- **A-mem esinli agentic memory linking**: Memory item’lara otomatik semantik `relatedMemoryIds` bağları eklendi (tenant scoped), search/list çıktısına yansıtıldı.

---

## 2026-03-18 — Production master key fail-fast kararı
### Problem
`MASTER_KEY_BASE64` tanımlı değilken servis deterministik dev fallback anahtarına düşebiliyordu; bu davranış production ortamında yanlış yapılandırma ile zayıf/öngörülebilir şifreleme riski yaratır.

### Seçenekler
- A: Mevcut fallback davranışını production'da da sürdürmek
- B: Production'da eksik/geçersiz anahtarda fail-fast olmak, dev/test fallback'i korumak

### Karar
**B seçildi:** `NODE_ENV=production` altında `MASTER_KEY_BASE64` yoksa veya 32 byte altı/geçersizse servis startup aşamasında hata verip durur.

### Gerekçe
- Güvenli varsayılanlar (secure-by-default) yaklaşımını uygular.
- Yanlış env konfigürasyonunu erken aşamada görünür kılar.
- Encryption-at-rest key yönetiminde operasyon disiplini sağlar.

### Etki
- Production deploy pipeline'larında secret eksikliği anında yakalanır.
- Geliştirme/test deneyimi bozulmaz (lokal fallback devam eder).
- Yanlış yapılandırmadan kaynaklı sessiz güvenlik zafiyeti riski azalır.

### Bilinçli Olarak Ertelenenler
- KMS/HSM entegrasyonu ve otomatik key rotation
- Startup secret health endpoint'i ve policy-as-code doğrulaması

---

## 2026-03-18 — Security telemetry + UI hardening kararı (dashboard sessionization)
### Problem
Security olayları runtime içinde görünür değildi; dashboard API key’i localStorage’da tutarak gereksiz tarayıcı risk yüzeyi yaratıyordu.

### Seçenekler
- A: Mevcut dashboard modelini korumak
- B: Sadece backend’de audit event toplayıp UI'yı değiştirmemek
- C: Tenant-scope security event feed + dashboard session token modeli + UI origin/header hardening

### Karar
**C seçildi:**
- `GET /v1/security/events` endpointi eklendi (tenant-scope audit feed)
- Dashboard auth modeli chat UI ile hizalandı (API key kalıcı saklanmıyor, kısa ömürlü session token)
- UI state-changing endpoint’lere (`/ui/session`, `/ui/session/revoke`) origin allowlist kontrolü eklendi
- UI static yanıtlarına CSP + güvenlik header’ları eklendi
- `x-tenant-id` format doğrulaması zorunlu hale getirildi

### Gerekçe
- Security operasyonları için doğrudan gözlemlenebilirlik sağlar.
- Browser-side key exposure riskini düşürür.
- Origin tabanlı istek hijack/CSRF benzeri riskleri azaltır.
- Header hardening ile clickjacking/MIME sniffing yüzeyi daraltılır.

### Etki
- Dashboard güvenlik posture’ı belirgin güçlendi.
- Tenant başına auth/rate-limit/session/origin olayları izlenebilir oldu.
- API kontratına yeni endpoint eklendi, test kapsamı genişledi.

### Bilinçli Olarak Ertelenenler
- Audit event persistence’in merkezi store’a taşınması (şu an process-memory bounded store)
- SIEM/OTEL export pipeline

---

## 2026-03-19 — OpenBB native tool entegrasyon kararı (no-code augmentation path)
### Problem
NOFX execution çekirdeğini bozmadan SMART-AI tarafında veri çeşitliliğini artırmak için OpenBB kaynaklarını doğrudan tool plane'e eklemek gerekiyor.

### Seçenekler
- A: Sadece mevcut `financial_deep_search` (stooq + alpha_vantage) ile devam etmek
- B: OpenBB'yi sadece dış araştırma notu seviyesinde bırakmak
- C: OpenBB API endpointlerini first-class tool (`openbb_search`) olarak entegre etmek

### Karar
**C seçildi:** `openbb_search` aracı eklendi ve planner/verifier/deep-research akışına bağlandı.

### Gerekçe
- OpenBB repo analizinde API endpointleri (`/api/v1/equity/price/quote`, `/api/v1/equity/price/historical`, `/api/v1/news/company`, `/api/v1/news/world`) doğrudan servislenebilir durumda.
- NOFX tarafını fork etmeden, SMART-AI'yı “analysis brain” olarak güçlendirme hedefiyle uyumlu.
- Tool-first entegrasyon, ileride provider/route genişletmesini düşük maliyetli hale getirir.

### Etki
- Finans/trading sorgularında OpenBB tabanlı market snapshot, trend ve haber özetleri üretilebiliyor.
- Verifier kalite kapısında OpenBB kanıtları güven sinyaline dahil edildi.
- Deep research akışı finans sorularında OpenBB pass ile genişledi.

### Bilinçli Olarak Ertelenenler
- OpenBB technical endpoints (`/api/v1/technical/*`) için payload zenginleştirme pipeline'ı
- OpenBB MCP server ile doğrudan tool discovery/autogen katmanı
- OpenBB response normalizasyonu için ayrı schema registry
