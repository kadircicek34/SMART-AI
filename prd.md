# PRD — OpenRouter Agentic Intelligence API

## Amaç
OpenRouter API key ile çalışan, ajan orkestrasyonlu ve tool-augmented bir **zeka katmanı** kurmak.
Bu katman dış dünyaya **OpenAI-compatible API** olarak açılacak ve chatbot ürünlerine doğrudan entegre edilebilecek.

## Problem
Tek başına LLM API çağrısı çoğu görevde yetersiz kalıyor:
- araştırma derinliği düşük,
- doğrulama adımı zayıf,
- tool kullanımında planlama/disiplin eksik,
- uzun görevlerde durum takibi ve güvenlik kontrolü yetersiz.

## Hedef Kullanıcı
- **Birincil:** Kendi chatbot ürününe gelişmiş ajan zekası eklemek isteyen ürün sahibi / teknik ekip.
- **İkincil:** Domain odaklı araştırma otomasyonu kuran ekipler (finans, içerik, analiz, operasyon).

## Başarı Kriterleri (MVP)
- [ ] OpenAI-compatible endpoint uyumluluğu: `/v1/chat/completions` temel akışında %95+ istemci uyumu.
- [ ] Tool-call görevlerinde başarı oranı: smoke benchmark setinde %80+ doğru tamamlama.
- [ ] Güvenlik: kritik seviye açık (API key sızıntısı, yetkisiz tenant erişimi, kontrolsüz tool çağrısı) = 0.
- [ ] Gözlemlenebilirlik: her istekte trace-id, tool-call logu, karar/step izi.
- [ ] Uzun görev desteği: async research işi başlatma + ilerleme stream + sonuç retrieval.

## Kapsam
### Dahil
1. OpenAI-compatible API katmanı
2. AgentFlow tarzı 4-rol orkestrasyon (Planner/Executor/Verifier/Synthesizer)
3. Poetiq tarzı düşünme rafinesi (candidate → evaluate → refine)
4. Tool plane:
   - web search (Brave primary + DuckDuckGo fallback),
   - wikipedia,
   - deep-research,
   - financial deep search,
   - tenant-isolated RAG search,
   - tenant-isolated memory search
5. RAG data plane:
   - tenant bazlı belge ingest (text/url),
   - chunking + retrieval API,
   - chat akışında `rag_search` tool entegrasyonu
6. Memory data plane:
   - tenant bazlı memory ingest/retrieve API,
   - pre-retrieval decision,
   - chat tarafında memory-worthy auto-capture
7. Multi-tenant güvenlik (BYOK OpenRouter key + policy + rate limit)
8. Audit/log/metrics

### Dahil Değil (MVP dışı)
- RL training pipeline (Flow-GRPO eğitim hattı)
- Çok bölgeli dağıtım / multi-region HA
- Marketplace / plugin store
- Agent self-modification

## Temel Akışlar
1. İstemci chatbot, OpenAI formatında istek atar.
2. API Gateway isteği doğrular (auth, tenant, quota, policy).
3. Orchestrator planner ile adım planlar.
4. Executor gerekli tool çağrılarını yapar.
5. Verifier sonuçları kalite/güvenilirlik açısından denetler.
6. Gerekirse Poetiq-style refine loop ile ikinci tur yapılır.
7. Synthesizer son cevabı standard response formatında döner.
8. Uzun araştırma ise async job olarak ilerleme eventi üretir.

## Çözüm Seçenekleri
### Seçenek A — Tek servis, senkron ağırlıklı
- Yaklaşım: API + orchestrator + tools tek process.
- Artılar: en hızlı başlangıç, düşük operasyonel yük.
- Eksiler: uzun görevlerde tıkanma, ölçeklenebilirlik sınırlı.

### Seçenek B — Modüler monolith + async worker (**Önerilen**)
- Yaklaşım: API katmanı ayrı, uzun görevler worker/queue ile.
- Artılar: MVP hızını korur, uzun görevleri güvenli ayrıştırır, prod'a evrilmesi kolay.
- Eksiler: A'ya göre biraz daha fazla altyapı karmaşıklığı.

### Seçenek C — Baştan microservices
- Yaklaşım: her domain ayrı servis (api/orchestrator/tools/research/security).
- Artılar: yüksek ölçek ve ekip ayrışması.
- Eksiler: erken aşamada aşırı maliyet ve yavaş teslim.

## Önerilen Yön
- **Seçilen yaklaşım:** Seçenek B (Modüler monolith + async worker)
- **Neden bu yön?** Üretim kalitesi + teslim hızı dengesi en güçlü bu modelde.
- **Bilinçli ertelenenler:** microservice parçalanması, RL training entegrasyonu.
- **Kullanıcı onay notu:** Başkanım tarafından “Tamam yap” onayı verildi.

## Reuse Stratejisi (Birebir vs İlham)
### Birebir yaklaşım (konsept/mantık seviyesinde doğrudan uygulama)
- AgentFlow: 4-rol orkestrasyon döngüsü
- Poetiq: iterative refine/evaluate mekanizması

### İlham alınıp yeniden inşa edilecekler
- Dexter: financial meta-router ve tool policy disiplini
- Open Deep Research: async workflow + progress stream modeli

### Bilinçli kopyalamama politikası
- Kör dosya kopyası yok.
- Lisans ve güvenlik net olmayan kod parçası taşınmaz.
- Pattern alınır, ürün ihtiyaçlarına göre temiz implement edilir.

## Tasarım / Mimari
### Ana birimler
1. **API Gateway**
   - OpenAI-compatible endpointler
   - auth, tenant, rate-limit
2. **Orchestrator Core**
   - Planner
   - Executor
   - Verifier
   - Synthesizer
3. **Thinking Engine**
   - candidate üretimi
   - değerlendirme
   - refine loop
4. **Tool Runtime**
   - web_search (Brave + fallback)
   - wikipedia
   - deep_research
   - financial_deep_search
   - rag_search
   - memory_search
5. **RAG Data Plane**
   - belge ingest (text/url)
   - chunk store + retrieval
   - tenant-isolated knowledge API
6. **Memory Data Plane**
   - memory ingest/upsert/list/delete
   - pre-retrieval decision (RETRIEVE/NO_RETRIEVE)
   - auto-capture (memory-worthy user messages)
7. **Async Research Worker**
   - uzun görev yürütme
   - event stream
8. **Security & Policy**
   - BYOK key vault
   - tool allowlist / denylist
   - budget guard (step/time/token)
9. **Observability**
   - tracing
   - audit
   - error analytics

### Veri / olay / kontrol akışı
- Request → Auth/Policy → Orchestrator → Tool Calls → Verification → Response
- Long job → Queue → Worker → Event stream → Final artifact

### Hata / fallback davranışı
- Tool timeout: fallback tool veya partial answer + reason
- Model başarısızlığı: model fallback chain (OpenRouter provider bazlı)
- Budget aşımı: kontrollü stop + kullanıcıya anlamlı status

### Entegrasyon sınırları
- İstemci için tek sözleşme: OpenAI-compatible API
- İçte provider değişebilir (OpenRouter üzerinden model bağımsızlığı)

## Dosya / Alan Etkisi (Planlanan)
- Yeni proje kökü:
  - `api/` (gateway + schemas + auth)
  - `orchestrator/` (planner/executor/verifier/synthesizer)
  - `tools/` (tool adapters)
  - `memory/` (memory ingest/retrieve)
  - `worker/` (async jobs)
  - `security/` (policy, key mgmt)
  - `observability/`
  - `tests/`
- Riskli alanlar:
  - key management
  - tool sandboxing
  - tenant isolation

## Teknik Notlar
- Platform: TypeScript + Node.js (API-first, ürün entegrasyonu için hızlı)
- OpenAI uyumluluk: request/response schema strict mode
- LLM katmanı: OpenRouter BYOK + provider fallback
- Queue/worker: Redis tabanlı job sistemi
- DB: tenant + audit + run metadata
- Dağıtım: container-ready
- İzolasyon: proje bazlı ayrı klasör, iteratif milestone teslimi
- Verification ownership: Yazılımcı (fresh verification zorunlu)
- Failing-test-first: API contract ve orchestration davranışlarında uygulanacak

## Güvenlik Temel Çizgi
- API key plaintext tutulmaz (encrypt-at-rest)
- Tenant boundary zorunlu
- Tool çalıştırma policy-gated
- Rate-limit + abuse guard
- Audit trail immutable/logged

## Riskler
1. Scope creep: tek seferde aşırı modül yüklenmesi
2. Multi-tool orchestration’da latency artışı
3. Yanlış policy ile tool overreach riski
4. Provider limit/timeout kaynaklı kullanıcı deneyimi bozulması
5. Memory verisinin yanlış sınıflandırma/yanlış retrieval nedeniyle kaliteyi bozması

## Referanslar
- https://github.com/lupantech/AgentFlow.git
- https://github.com/poetiq-ai/poetiq-arc-agi-solver.git
- https://github.com/virattt/dexter.git
- https://github.com/Nutlope/open-deep-research.git
- https://github.com/NevaMind-AI/memU
