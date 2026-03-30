# DECISIONS — OpenRouter Agentic Intelligence API

## 2026-03-29 — Tamper-evident security export pipeline kararı
### Problem
Security summary ve event feed tenant içinde görünür hale gelmişti; ancak üç kritik operasyon/güvenlik açığı sürüyordu:
1. Incident-response veya SIEM ingestion için audit evidence dışarı alınamıyordu.
2. Export edilen olayların transfer sonrası değiştirilip değiştirilmediğini doğrulayan hash-chain mekanizması yoktu.
3. Dashboard’da risk seviyesi görünse de operatörün tek tıkla security bundle indirme yüzeyi eksikti.

### Seçenekler
- A: Mevcut `/v1/security/events` + `/v1/security/summary` yüzeyiyle devam etmek
- B: Doğrudan webhook/SIEM push hattısına geçmek
- C: Admin-scope export API + verify endpoint + tamper-evident hash chain + dashboard download akışını tek koşumda teslim etmek

### Karar
**C seçildi:**
1. **Yeni özellik:** `GET /v1/security/export` ile tenant bazlı tamper-evident audit bundle export eklendi.
2. **Ciddi güvenlik iyileştirmesi #1:** Audit eventler artık `sequence`, `prev_chain_hash`, `chain_hash` alanlarıyla zincirleniyor; export bundle üzerinde transfer sonrası bütünlük kanıtı üretilebiliyor.
3. **Ciddi güvenlik iyileştirmesi #2:** `POST /v1/security/export/verify` ile export bundle server-side doğrulanabiliyor; değiştirilmiş payload deterministik biçimde yakalanıyor.
4. **Ciddi güvenlik iyileştirmesi #3:** Export ve verify yüzeyi `tenant:admin` scope arkasına alındı; read-only credential’lar summary okuyabilirken delil paketi export edemiyor.
5. **Ops / UX iyileştirmesi:** Dashboard artık gerçek `/v1/security/summary` verisini risk + integrity bilgisiyle gösteriyor ve tek tık security export indiriyor.

### Gerekçe
- Security event listesi incident-response için yararlıydı ama dış sisteme taşınabilir, doğrulanabilir evidence üretmiyordu.
- Hash-chain, ayrı bir KMS/SIEM yatırımı yapmadan audit log’u daha güvenilir hale getirmenin düşük maliyetli yolunu sağladı.
- Export/verify/dash akışını aynı koşumda teslim etmek, bu özelliği “yalnızca backend capability” olmaktan çıkarıp operasyonel olarak gerçekten kullanılabilir hale getirdi.

### Etki
- Tenant admin artık son pencerenin security evidence paketini indirip tekrar doğrulayabiliyor.
- Summary endpoint nihayet gerçek risk + integrity telemetry döndürüyor.
- Security audit log persistence’i eski snapshot’lardan geriye uyumlu biçimde hash-chain’e yükseltildi.

### Bilinçli Olarak Ertelenenler
- Webhook/SIEM push delivery hattı
- Public-key signed export manifest / dış doğrulayıcı dağıtımı
- UI session / audit / policy store için shared persistence backend

---

## 2026-03-28 — Tenant remote source policy control plane kararı
### Problem
Secure remote RAG preview/ingest hattı SSRF açısından fail-closed hale getirilmişti; ancak üretimde iki kritik açık kalmıştı:
1. Tenant bazlı remote kaynak onayı yoktu, yani arbitrary public URL’ler doğrudan ingest edilebiliyordu.
2. Unicode host / wildcard eşleşme kenar durumlarında allowlist bypass riski kalıyordu.
3. Operatörün dashboard üzerinden remote source policy’yi görüp yönetebileceği bir kontrol yüzeyi yoktu.

### Seçenekler
- A: Mevcut remote preview/ingest hattını koruyup operatör yönergesi ile devam etmek
- B: Remote URL ingest’i tekrar tamamen kapatmak
- C: Secure-by-default tenant remote source policy API + dashboard + audit telemetry + regression test paketiyle production-grade governance eklemek

### Karar
**C seçildi:**
1. **Yeni özellik:** `GET/PUT/DELETE /v1/rag/remote-policy` endpointleri ve dashboard paneli ile tenant bazlı remote source policy control plane eklendi.
2. **Ciddi güvenlik iyileştirmesi #1:** Deployment varsayılanı `preview_only` yapıldı; remote URL preview açık kalırken ingest artık explicit policy olmadan kapalı.
3. **Ciddi güvenlik iyileştirmesi #2:** `allowlist_only` modunda ingest yalnızca exact public host/IP veya `*.example.com` wildcard kurallarıyla açılıyor; Unicode host girişleri punycode normalize edilerek suffix/homograph bypass riski daraltıldı.
4. **Ciddi güvenlik iyileştirmesi #3:** Yeni audit eventleri (`rag_remote_policy_denied`, `rag_remote_policy_updated`, `rag_remote_policy_reset`) security feed ve risk scoring içine alındı.
5. **UX / DX iyileştirmesi:** Dashboard’da remote policy görünürlüğü ve düzenleme akışı eklendi; RAG belge metriği bug’ı da düzeltildi.

### Gerekçe
- Remote fetch güvenliği sadece SSRF bloklarıyla tamamlanmıyor; hangi dış kaynakların ingest edilebildiğinin policy seviyesinde yönetilmesi gerekiyor.
- Secure-by-default `preview_only` modu, operasyon ekibine gözlem yeteneği verirken doğrudan bilgi tabanı kirlenmesini ve kontrolsüz egress’i azaltıyor.
- Dashboard yönetimi olmadan bu yüzey yalnızca API seviyesinde kalacak ve operasyonel benimsenmesi zayıf olacaktı.

### Etki
- Remote URL ingest artık tenant onayı olmadan çalışmıyor.
- Allowlist kuralları daha deterministik ve denetlenebilir hale geldi.
- Security summary tekrarlayan remote policy deny sinyallerini risk göstergesi olarak sayabiliyor.

### Bilinçli Olarak Ertelenenler
- DNS lookup→connect pinning ile daha sert anti-rebinding koruması
- Multi-tenant approval workflow / insan-onaylı staged source approvals
- Security event webhook/SIEM export pipeline

---

## 2026-03-27 — Secure remote RAG URL ingest + preview gate kararı
### Problem
RAG URL ingest hattı doğrudan arbitrary remote fetch yaptığı için production riskleri oluşuyordu:
1. SSRF ile localhost / private-network / metadata IP hedeflerine erişim denenebilirdi.
2. Redirect zinciri, credential gömülü URL, disallowed MIME ve aşırı büyük body senaryolarında fail-closed guard yoktu.
3. Operatörün ingest öncesi URL’yi güvenli biçimde preview etmesini sağlayan kullanıcı-facing bir yüzey yoktu.

### Seçenekler
- A: Mevcut URL ingest akışını koruyup sadece dokümantasyon uyarısı eklemek
- B: URL ingest’i tamamen kapatmak
- C: Güvenli remote fetch policy + preview endpoint + audit telemetry + regression test paketi ile aynı koşumda production-grade sertleştirme yapmak

### Karar
**C seçildi:**
1. **Yeni özellik:** `POST /v1/rag/url-preview` endpointi eklendi; operatör ingest öncesi `final_url`, `redirects`, `content_type`, `content_length_bytes`, `excerpt` gibi güvenli metadata ile preview alabiliyor.
2. **Ciddi güvenlik iyileştirmesi #1:** Remote fetch hattı localhost / RFC1918 / link-local / CGNAT / reserved IP blokları, credential gömülü URL reddi ve port allowlist ile fail-closed hale getirildi.
3. **Ciddi güvenlik iyileştirmesi #2:** Redirect zinciri her hop’ta yeniden doğrulanıyor; redirect loop / missing location / unsafe target durumları bloklanıyor.
4. **Ciddi güvenlik iyileştirmesi #3:** MIME allowlist + byte cap + timeout guard eklendi; binary/oversized cevaplar ingest öncesi reddediliyor.
5. **Ops görünürlüğü:** `rag_remote_url_blocked`, `rag_remote_url_fetch_failed`, `rag_remote_url_previewed`, `rag_remote_url_ingested` audit eventleri eklendi.

### Gerekçe
- RAG surface doğrudan dış URL aldığı için SSRF ve payload-abuse riski diğer yüzeylerden daha yüksekti.
- Preview endpointi operatörün hatalı veya riskli kaynakları ingest etmeden önce ayıklamasını sağlıyor.
- Güvenlik, test ve docs aynı koşumda güncellenmeden bu alan production-grade sayılmazdı.

### Etki
- Remote RAG ingest artık public-safe URL policy ile çalışıyor.
- Tenant admin / operator akışı preview → ingest şeklinde daha kontrollü hale geldi.
- Bloklanan remote fetch denemeleri security feed’e düşerek incident-response görünürlüğü kazandı.

### Bilinçli Olarak Ertelenenler
- DNS pinning / custom dispatcher ile lookup→connect arası daha sert anti-rebinding koruması
- Tenant bazlı domain allowlist / approval workflow
- SIEM/webhook export ile blocked fetch eventlerinin dış sisteme aktarılması

---

## 2026-03-26 — Persistent security control plane + admin session response kararı
### Problem
İki üretim açığı aynı anda öne çıktı:
1. UI session store ve security audit store process-memory olduğu için restart sonrası güvenlik state'i kayboluyordu.
2. Tenant admin’in çalınmış/unutulmuş dashboard oturumlarını uzaktan görebileceği ve kapatabileceği bir incident-response yüzeyi yoktu.
3. Dependency taramasında Fastify için `GHSA-444r-cwp2-x5xf` advisory’si göründü; reverse-proxy başlık spoofing riski kapatılmalıydı.

### Seçenekler
- A: Mevcut memory-only store + manuel restart/re-login yaklaşımı ile devam etmek
- B: Sadece UI tarafında görünürlük ekleyip persistence katmanını ertelemek
- C: Hashed session persistence + kalıcı audit evidence + admin session inventory/revoke API + dependency patch aynı koşumda teslim etmek

### Karar
**C seçildi:**
1. **Yeni özellik:** `GET /v1/ui/sessions`, `POST /v1/ui/sessions/:sessionId/revoke`, `POST /v1/ui/sessions/revoke-all` ile tenant admin session control plane eklendi.
2. **Ciddi güvenlik iyileştirmesi #1:** UI session store restart-resistant file-backed persistence'a taşındı; plaintext token saklanmıyor, yalnızca hash+metadata tutuluyor.
3. **Ciddi güvenlik iyileştirmesi #2:** Security audit log restart-resistant file-backed persistence'a taşındı; bounded retention + sanitize/redaction korunuyor.
4. **Ciddi güvenlik iyileştirmesi #3:** `fastify` güvenlik advisory’sini kapatmak için bağımlılık güvenli sürüme yükseltildi.
5. **Ops/UX iyileştirmesi:** Dashboard'a aktif session görünürlüğü ve “Diğer Oturumları Kapat” akışı eklendi.

### Gerekçe
- Restart sonrası güvenlik evidence ve aktif session state'inin kaybolması hem operasyonel görünürlüğü hem incident-response hızını düşürüyordu.
- Session revoke-all yüzeyi olmadan ele geçirilmiş browser oturumlarını tenant admin hızlıca düşüremiyordu.
- Bağımlılık seviyesindeki bilinen advisory kapatılmadan production-grade teslim iddiası eksik kalırdı.

### Etki
- Tek instance prod kurulumlarında UI session ve audit evidence artık restart sonrası korunur.
- Dashboard üzerinden güvenli self-preserving bulk revoke akışı sağlandı.
- Dependency audit tekrar yeşile döndü (`npm audit --omit=dev` → 0 vulnerability).

### Bilinçli Olarak Ertelenenler
- UI session/audit persistence'ı Redis/Postgres gibi shared/distributed backend'e taşıma
- Session yönetimi için tenant içi tam kullanıcı/RBAC/approval workflow
- SIEM/webhook export pipeline

---

## 2026-03-21 — Async runtime cancellation + model allowlist security hardening kararı
### Problem
Async research işlerinde cancel çağrısı running task’i anında kesemiyor, idempotency kayıtları süresiz büyüyebiliyor ve model parametresi allowlist dışına taşarak maliyet/güvenlik riski üretebiliyordu.

### Seçenekler
- A: Mevcut best-effort cancel + açık model seçimi ile devam etmek
- B: Sadece UI seviyesinde uyarı eklemek
- C: Worker/LLM/tool zincirinde AbortSignal tabanlı gerçek cancellation + model allowlist enforcement + idempotency TTL/store cap

### Karar
**C seçildi:**
1. **Yeni özellik:** Running async job’lar için gerçek cancel/timeout davranışı (AbortSignal zinciri + `cancellation_reason`, `started_at`, `completed_at` alanları).
2. **Güvenlik iyileştirmesi:** `OPENROUTER_ALLOWED_MODELS` allowlist + model format/uzunluk doğrulaması (`api_model_rejected` audit event).
3. **Güvenlik iyileştirmesi:** Idempotency kayıtlarına TTL + tenant başına job store cap (`RESEARCH_IDEMPOTENCY_TTL_SECONDS`, `RESEARCH_MAX_JOBS_PER_TENANT`).
4. **Dayanıklılık iyileştirmesi:** LLM/tool fetch ve mcporter/qmd çağrılarına signal propagation ile timeout/cancel uyumu.

### Gerekçe
- Runtime’da gerçekten kesilemeyen işler maliyet, kuyruk şişmesi ve DoS riskini artırır.
- Model allowlist yoksa deployment policy dışı model kullanımı oluşabilir.
- Sınırsız idempotency/job birikimi bellek tüketimi ve tenant izolasyonunu zayıflatır.

### Etki
- Cancel edilen veya timeout olan işler artık `cancelled` + reason ile deterministik kapanır.
- Model probing ve allowlist dışı model kullanım denemeleri güvenlik feed’de görünür olur.
- Job/idempotency store büyümesi bounded hale gelir.

### Bilinçli Olarak Ertelenenler
- Job store’un Redis/Postgres’e taşınması
- Per-tenant dinamik model allowlist yönetim UI/API katmanı

---

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

---

## 2026-03-19 — Async research lifecycle hardening kararı (idempotent + cancellable jobs)
### Problem
Async research endpointi (`POST /v1/jobs/research`) duplicate submit, tenant başına job fırtınası ve runtime error message sızıntısı riskleri taşıyordu. Ayrıca operasyon tarafında job listesi ve güvenli cancel lifecycle eksikti.

### Seçenekler
- A: Mevcut minimal enqueue/get modeliyle devam etmek
- B: Sadece rate-limit artırıp uygulama katmanını değiştirmemek
- C: Job lifecycle’i üretim seviyesine çıkarmak (idempotency + active job cap + list/cancel + audit + redaction)

### Karar
**C seçildi:**
1. **Yeni özellik:** Job lifecycle endpointleri genişletildi.
   - `GET /v1/jobs`
   - `POST /v1/jobs/:jobId/cancel`
   - `POST /v1/jobs/research` için `Idempotency-Key` desteği
2. **Güvenlik sertleştirmesi:** Tenant başına aktif async job limiti eklendi (`RESEARCH_MAX_ACTIVE_JOBS_PER_TENANT`).
3. **Güvenlik sertleştirmesi:** Idempotency key format doğrulaması + farklı payload ile replay conflict koruması eklendi.
4. **Güvenlik sertleştirmesi:** Job failure error mesajları redacted/sanitize edilerek secret sızıntı riski azaltıldı.
5. **Gözlemlenebilirlik:** Security event feed’e research job event tipleri eklendi.

### Gerekçe
- Duplicate submit ve retry storm durumlarında aynı işi tekrar tekrar çalıştırmamak maliyet/süre avantajı sağlar.
- Tenant başına aktif job sınırı, kaynak tüketimi tabanlı kötüye kullanım riskini azaltır.
- Error redaction, özellikle provider token/authorization parçalarının API response üzerinden sızmasını engeller.
- Job list/cancel endpointleri operasyonel kontrol ve güvenli recovery sağlar.

### Etki
- Async research yüzeyi artık replay-safe ve tenant bazlı kapasite kontrollü.
- Ops/UI katmanları queued/running/completed/failed/cancelled lifecycle’ı tek API ile izleyebilir.
- Güvenlik telemetry’sinde job kaynaklı olaylar da tenant bazlı raporlanabilir.

### Bilinçli Olarak Ertelenenler
- Running job için gerçek runtime cancellation (AbortSignal ile tool-level interrupt zinciri)
- Job store’un kalıcı bir backend’e taşınması (Redis/Postgres)
- Idempotency kayıtları için TTL + persistence policy

## 2026-03-20 — Security intelligence summary + header abuse hardening kararı
### Problem
Security event feed vardı ancak operasyon ekibi olayları elle okumadan risk seviyesini hızlı göremiyordu. Ayrıca header/payload boyutu suistimallerine karşı sınırlar açık tanımlı değildi.

### Seçenekler
- A: Sadece mevcut `/v1/security/events` listesini kullanmaya devam etmek
- B: Ayrı SIEM entegrasyonu gelene kadar beklemek
- C: Tenant-scope risk özet endpointi + dashboard görünürlüğü + header/payload boyut sertleştirmelerini aynı koşumda eklemek

### Karar
**C seçildi:**
1. **Yeni özellik:** `GET /v1/security/summary` endpointi eklendi (riskScore, riskLevel, alertFlags, topIps, byType).
2. **Güvenlik sertleştirmesi:** Authorization/Bearer/Tenant header boyut limitleri eklendi (`431` reject path).
3. **Güvenlik sertleştirmesi:** UI session login için oversized API key payload reddi eklendi.
4. **Güvenlik sertleştirmesi:** Security audit detaylarında secret redaction + normalize/sanitize katmanı eklendi.
5. **UX/ops:** Dashboard risk kartı ile 24h güvenlik riski tek bakışta görünür hale getirildi.

### Gerekçe
- Security operasyonlarında “event listesi” yerine “risk özeti” karar hızını artırır.
- Header abuse ve oversized payload reddi, auth yüzeyinde düşük maliyetli ama yüksek etkili bir sertleştirmedir.
- Audit detail redaction, telemetry üzerinden token/key sızıntısı riskini düşürür.

### Etki
- Tenant bazlı güvenlik posture tek endpoint ile ölçülebilir hale geldi.
- Dashboard artık sadece olay sayısı değil, risk seviyesi ve alarm bayraklarını da gösteriyor.
- Auth/UI giriş yüzeyinde header/payload kaynaklı kötüye kullanım penceresi daraltıldı.

### Bilinçli Olarak Ertelenenler
- Persisted audit analytics store (Redis/Postgres/SIEM)
- Anomali tespiti için zaman serisi tabanlı ML/istatistiksel model
- IP reputation/geo intelligence entegrasyonu

## 2026-03-24 — Tenant model policy yönetimi + fail-closed enforcement kararı
### Problem
Model allowlist yalnızca deployment seviyesinde tutuluyordu; tenant bazında daha dar, güvenli ve ürün odaklı model seti tanımlanamıyor, ayrıca model parametresi verilmediğinde tutarlı bir tenant default seçimi bulunmuyordu.

### Seçenekler
- A: Sadece deployment-level allowlist ile devam etmek
- B: UI tarafında pasif model etiketi gösterip backend davranışını değiştirmemek
- C: Tenant bazlı model policy API + default model fallback + fail-closed invalid policy enforcement

### Karar
**C seçildi:**
1. **Yeni özellik:** `GET/PUT/DELETE /v1/model-policy` ile tenant bazlı allowlist + default model yönetimi eklendi.
2. **Ciddi güvenlik iyileştirmesi #1:** Chat ve async research job endpointleri artık tenant effective policy dışındaki modelleri reddediyor.
3. **Ciddi güvenlik iyileştirmesi #2:** Deployment allowlist dışında tenant policy yazılamıyor; invalid/stale tenant policy durumunda sistem fail-closed davranıyor.
4. **Ops/telemetry iyileştirmesi:** `model_policy_updated`, `model_policy_reset`, `model_policy_change_rejected` audit eventleri eklendi.
5. **UX iyileştirmesi:** Dashboard policy yönetim paneli eklendi; chat UI tenant default modeli otomatik seçiyor.

### Gerekçe
- Tenant bazlı model sınırları maliyet, güvenlik ve ürün segmentasyonu için gerekliydi.
- Model parametresi zorunluluğu istemci entegrasyonunu gereksiz yere kırılgan yapıyordu.
- Deployment policy değiştiğinde stale tenant kayıtlarının sessizce geniş yetkiye düşmesi kabul edilemezdi.

### Etki
- Her tenant kendi güvenli model alt kümesine ve varsayılan modeline sahip olabiliyor.
- Model omission artık kontrollü biçimde tenant default üzerinden çalışıyor.
- Policy escape denemeleri ve reddedilen konfigürasyonlar security feed’de görünür hale geldi.

### Bilinçli Olarak Ertelenenler
- Model policy store’un Redis/Postgres gibi shared backend’e taşınması
- Policy değişiklikleri için role-based admin scopes / approver workflow
- Dashboard tarafında çok-tenant toplu policy yönetimi

---

## 2026-03-22 — UI session lifecycle hardening + zero-downtime token rotation kararı
### Problem
UI tarafında session token modeli vardı ancak üç kritik açık bulunuyordu:
1. Token yenileme akışı olmadığı için dashboard/chat tarafında token bitişi kullanıcı deneyimini kesiyordu.
2. Session store için tenant/global üst sınır olmadığından memory-DoS riski bulunuyordu.
3. Idle session kontrolü ve fingerprint doğrulaması eksik olduğundan token ele geçirilmesi durumunda kötüye kullanım penceresi uzundu.

### Seçenekler
- A: Sadece token TTL artırmak (kısa vadeli UX düzeltmesi, güvenlik kazanımı zayıf)
- B: Refresh endpoint ekleyip güvenlik katmanını olduğu gibi bırakmak
- C: Session lifecycle’ı uçtan uca sertleştirmek (refresh/introspection + idle timeout + UA binding + cap eviction + UI auto-refresh)

### Karar
**C seçildi:**
1. **Yeni özellik:**
   - `GET /ui/session` endpointi eklendi (aktif session introspection: expiry, idle window, remaining seconds)
   - `POST /ui/session/refresh` endpointi eklendi (token rotation; eski token anında geçersiz)
2. **Ciddi güvenlik iyileştirmesi #1:**
   - UI session’larda idle-timeout enforcement eklendi (`UI_SESSION_MAX_IDLE_SECONDS`)
   - `/v1/*` auth middleware artık session resolve sırasında `lastSeenAt` touch + idle expiry uygular
3. **Ciddi güvenlik iyileştirmesi #2:**
   - User-Agent fingerprint binding eklendi (token farklı UA ile kullanılırsa session düşürülür)
4. **Ciddi güvenlik iyileştirmesi #3:**
   - Tenant başına ve global aktif session cap eklendi (`UI_SESSION_MAX_SESSIONS_PER_TENANT`, `UI_SESSION_MAX_SESSIONS_GLOBAL`)
   - En eski tokenlar otomatik evict edilerek store büyümesi kontrol altına alındı
5. **Ops/telemetry genişletmesi:**
   - Yeni security event tipleri: `ui_session_rotated`, `ui_session_validation_failed`, `ui_session_refresh_failed`
   - Risk summary skorlama/flag mantığı session-anomaly sinyalleriyle güncellendi

### Gerekçe
- Session rotation + auto-refresh kombinasyonu kullanıcı deneyimini kesmeden güvenlik posture’unu yükseltir.
- Idle timeout + fingerprint binding, token theft etkisini anlamlı şekilde sınırlar.
- Session cap, bellek tüketimi tabanlı suistimalleri düşük maliyetle azaltır.

### Etki
- Dashboard/chat token kesintileri azaldı; token bitişine yakın otomatik refresh yapılabiliyor.
- UI auth yüzeyi replay/hijack ve resource abuse risklerine karşı daha dayanıklı hale geldi.
- Security event feed artık session-odaklı anomali sinyallerini de taşıyor.

### Bilinçli Olarak Ertelenenler
- Multi-signal device fingerprint (IP + UA + client-hints) ile adaptif risk scoring
- Session store’un process-memory yerine Redis’e taşınması
- Revoked token bloom-filter/denylist ile distributed revoke propagation

## 2026-03-25 — Scoped API keys + auth context + UI session origin binding

### Problem
1. Tenant auth modeli tek seviyeli olduğu için dashboard/read-only kullanım ile admin operasyonları arasında yetki ayrımı yoktu.
2. `PUT /v1/model-policy`, `/v1/keys/openrouter*`, `/v1/mcp/reset|flush` gibi hassas yüzeyler çalınmış veya aşırı yetkili credential ile gereksiz yere açık kalıyordu.
3. UI session token’ları `/v1/*` state-changing çağrılarda origin-bound değildi; token ele geçirilirse browser dışı/kötü origin kullanım penceresi gereğinden genişti.

### Seçenekler
- A: Mevcut tek-seviye anahtar modelini koruyup sadece dashboard tarafında buton gizlemek
- B: Tam tenant/user RBAC sistemi kurmak (yüksek etki ama tek günlük koşum için aşırı büyük)
- C: Scope tabanlı credential modeli + auth introspection + hassas endpoint gating + UI session origin binding

### Karar
**C seçildi:**
1. **Yeni özellik:**
   - `APP_API_KEY_DEFINITIONS` ile scope tanımlı credential registry eklendi.
   - Yeni endpoint: `GET /v1/auth/context`
   - Dashboard ve Chat UI artık aktif credential’ın scope’larını okuyup kontrol yüzeyini yetkiye göre otomatik ayarlıyor.
2. **Ciddi güvenlik iyileştirmesi #1:**
   - Scope hiyerarşisi tanımlandı: `tenant:read` → `tenant:operate` → `tenant:admin`
   - `/v1/model-policy`, `/v1/keys/openrouter*`, `/v1/mcp/reset`, `/v1/mcp/flush` admin scope gerektiriyor.
   - Legacy `APP_API_KEYS` backward-compatible olarak full admin davranışını koruyor.
3. **Ciddi güvenlik iyileştirmesi #2:**
   - UI session’lar artık giriş yapılan principal adını ve scope setini taşır; refresh/rotation akışında da bu yetki korunur.
   - Böylece read-only veya operate-only anahtarlar UI üzerinden admin aksiyonuna sıçrayamaz.
4. **Ciddi güvenlik iyileştirmesi #3:**
   - UI session token ile yapılan state-changing `/v1/*` çağrıları allowlisted Origin’e bağlandı.
   - Eksik veya uygunsuz origin, audit event ile 403 döner.
5. **Telemetry genişletmesi:**
   - Yeni event tipi: `api_scope_denied`
   - Risk summary artık tekrar eden privilege probing denemelerini `privilege_escalation_attempts` bayrağı ile işaretleyebilir.

### Gerekçe
- Tek turda production-grade ve geri uyumlu bir en düşük ayrıcalık (least privilege) katmanı kurmak mümkün oldu.
- Auth introspection sayesinde yalnızca backend enforcement değil, frontend operatör deneyimi de güvenli varsayılanlara geçti.
- Origin binding, UI session token’larının browser-tab context dışına taşınmasını zorlaştırarak gerçek saldırı yüzeyini küçültür.

### Etki
- Read-only dashboard erişimi ile admin operasyonları artık güvenli şekilde ayrışıyor.
- Chat UI, operate yetkisi olmayan session ile yanlışlıkla iş yükü başlatamıyor.
- Admin yüzeylerinde yetkisiz denemeler güvenlik feed’ine görünür şekilde düşüyor.

### Bilinçli Olarak Ertelenenler
- Tenant içi kullanıcı bazlı tam RBAC/approval workflow
- API key registry’nin env yerine merkezi secret backend’den yönetilmesi
- UI session store ve audit store’un shared/distributed persistence’a taşınması

---

## 2026-03-30 — Tamper-evident security export delivery + egress hardening
### Problem
1. Security export bundle’ları yalnızca indirilebiliyordu; SIEM/webhook tarafına güvenli, otomasyon dostu teslim yolu yoktu.
2. Export delivery eklendiği anda SSRF, private-network egress, replay ve secret leak riskleri doğacaktı.
3. Operatör tarafında hangi export’un nereye gittiği, başarı/başarısızlık durumu ve audit chain referansı görünür değildi.

### Seçenekler
- A: Sadece JSON download bırakmak (en güvenli ama operasyonel değeri düşük)
- B: Serbest URL’e `fetch()` ile POST atmak (hızlı ama production güvenliği zayıf)
- C: Tenant allowlist kontrollü, HTTPS-only, DNS-pinned, HMAC-imzalı delivery API + dashboard + receipt history

### Karar
**C seçildi:**
1. **Yeni özellik:**
   - `GET/POST /v1/security/export/deliveries` eklendi.
   - Dashboard’a webhook/SIEM delivery paneli ve recent receipt tablosu eklendi.
   - Export bundle artık tek tıkla dış sisteme gönderilebiliyor ve delivery geçmişi saklanıyor.
2. **Ciddi güvenlik iyileştirmesi #1:**
   - Delivery yalnızca HTTPS hedeflere açık.
   - Embedded credential içeren URL’ler reddediliyor.
   - Host, tenant remote source allowlist içinde değilse delivery bloklanıyor.
3. **Ciddi güvenlik iyileştirmesi #2:**
   - Hedef hostname public DNS üzerinden resolve edilip pinned address ile bağlanılıyor; private/link-local/reserved ağ egress’i reddediliyor.
   - Allowed port listesi ile gereksiz egress yüzeyi daraltıldı.
4. **Ciddi güvenlik iyileştirmesi #3:**
   - Her delivery için tenant-scoped HMAC header seti (`x-smart-ai-signature`, `content-digest`, timestamp/nonce metadata) üretildi.
   - Path/query değerleri loglanmıyor; receipt tarafında yalnızca redacted destination metadata tutuluyor.
5. **Telemetry / ops iyileştirmesi:**
   - Yeni audit event tipleri: `security_export_delivered`, `security_export_delivery_failed`, `security_export_delivery_blocked`
   - Risk summary artık delivery instability ve egress policy violation sinyallerini işaretleyebiliyor.
   - Receipt store sayesinde hangi export’un hangi chain head ile teslim edildiği izlenebilir hale geldi.

### Gerekçe
- Security export’un gerçek operasyonel değeri, sadece download değil güvenli teslim kabiliyetiyle ortaya çıkıyor.
- Serbest outbound POST modeli, audit ve security ürünü için kabul edilemez kadar geniş saldırı yüzeyi yaratır.
- Allowlist + DNS pinning + HMAC kombinasyonu tek günlük koşum içinde güçlü bir production baseline sundu.

### Etki
- Tenant admin’leri audit bundle’larını kontrollü şekilde SIEM/webhook tarafına push edebiliyor.
- Export egress yüzeyi audit’lenebilir, allowlist kontrollü ve tamper-evident hale geldi.
- Dashboard operatörü başarı/başarısızlık geçmişini ve chain hash referansını tek yerden görebiliyor.

### Bilinçli Olarak Ertelenenler
- Delivery retry queue / exponential backoff worker
- Public-key (asymmetric) signature + key rotation registry
- Çok hedefli scheduled export policies / per-destination secret negotiation
