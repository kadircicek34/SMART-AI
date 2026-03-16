# memU Analysis — 2026-03-16 (mcporter + github-readonly + repomix)

## Araçlar
- `mcporter call github-readonly.list_commits`
- `mcporter call github-readonly.list_releases`
- `mcporter call repomix.pack_remote_repository`

## Kaynak Repo
- Repo: `https://github.com/NevaMind-AI/memU`
- Son commit: `163d050299b77143226e9727f67d4826c9a69f92`
- Commit mesajı: `docs: Update Discord link in README.md (#377)`

## Repomix Özeti
- Toplam dosya: **213**
- Toplam token: **295,011**
- En yoğun dosyalar:
  - `src/memu/app/retrieve.py`
  - `src/memu/app/memorize.py`
  - `src/memu/app/crud.py`
  - `src/memu/app/service.py`
  - `src/memu/prompts/retrieve/pre_retrieval_decision.py`

## Kritik Pattern Bulguları
1. **Service composition (Memorize + Retrieve + CRUD mixins)**
   - `MemoryService(MemorizeMixin, RetrieveMixin, CRUDMixin)`
   - Ayrık sorumluluk + birleştirici servis tasarımı
2. **Pre-retrieval decision katmanı**
   - Retrieval gerekip gerekmediğini ayrı bir karar adımıyla yönetiyor
   - Gereksiz memory erişimini kesiyor
3. **Workflow interceptor yaklaşımı**
   - Step-level before/after/on_error interception
   - Çapraz kesen davranışları merkezi yönetim
4. **Kategori bazlı memory tipi yaklaşımı**
   - profile/preference/habit/goal/todo/knowledge benzeri sınıflandırma

## SMART-AI için alınan karar
- Birebir kod taşıma: **Hayır**
- Pattern entegrasyonu: **Evet**

## Bu koşumda uygulananlar
- Tenant-izole memory store + memory service (`service/memory/*`)
- Pre-retrieval decision (`RETRIEVE/NO_RETRIEVE`) akışı
- Memory kategori modeli + search scoring
- Orchestrator’da `memory_search` tool entegrasyonu
- Chat tarafı memory-worthy auto-capture

## Sonraki aday iyileştirmeler
- Memory ranker için embedding + hybrid retrieval
- Memory/RAG store için DB backend + encryption-at-rest
- Interceptor olaylarının telemetry/export katmanı
