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
