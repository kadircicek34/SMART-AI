# External Repo Analysis — 2026-03-16

## Yöntem (mcporter + MCP)
Bu analizde yalnızca MCP üzerinden şu çağrılar kullanıldı:
- `github-readonly.list_commits`
- `github-readonly.list_releases`
- `repomix.pack_remote_repository`

İncelenen repolar:
1. `volcengine/OpenViking`
2. `openclaw/openclaw`
3. `topoteretes/cognee`
4. `tobi/qmd`

---

## 1) OpenViking
- Son commit: `18f120671a6ed5edba6d1cfb91a20ee28c450ec0`
- Repomix: `1511 file`, `3433320 token`
- Öne çıkan dosyalar:
  - `openviking/retrieve/memory_lifecycle.py`
  - `openviking/retrieve/retrieval_stats.py`
  - `openviking/retrieve/hierarchical_retriever.py`

### Alınan pattern
- **Hotness scoring** (retrieval_count + recency decay)
- **Retrieval telemetry** (query/result/latency sayaçları)

### SMART-AI'a uygulama
- Memory scoring içine hotness boost eklendi.
- Tenant memory stats içine retrieval metrikleri eklendi.

---

## 2) openclaw/openclaw
- Son commit: `476d948732d0269206fadf78d3463ce7df30e078`
- Repomix: `7099 file`, `5072410 token`
- Öne çıkan dosyalar:
  - `src/memory/qmd-manager.ts`
  - `src/memory/qmd-process.ts`
  - `src/memory/search-manager.ts`

### Alınan pattern
- CLI process wrapper + timeout
- fallback-safe yaklaşım
- qmd tabanlı memory/search entegrasyonu

### SMART-AI'a uygulama
- `qmd_search` aracı eklendi.
- QMD collection auto-bootstrap eklendi (`collection list/add`).
- QMD JSON parse + graceful fallback + timeout davranışı eklendi.

---

## 3) Cognee
- Son commit: `5469622dabc528d59921be711ade5bcb379889e7`
- Repomix: `1704 file`, `4350067 token`
- Öne çıkan dosyalar:
  - `cognee/modules/memify/memify.py`
  - `cognee/modules/retrieval/utils/brute_force_triplet_search.py`
  - `cognee/api/v1/search/search.py`

### Alınan pattern
- Pipeline-first memify yaklaşımı
- Retrieval utility katmanlarının ayrıştırılması
- Search modüllerinde tip bazlı yönlendirme

### SMART-AI'a uygulama
- Memory plane service katmanı modüler tutuldu (memorize/retrieve/stats).
- Orchestrator’da memory/project-doc query ayrımı güçlendirildi.

---

## 4) QMD
- Son commit: `2b8f329d7e4419af736a50e917057f685ad41110`
- Repomix: `112 file`, `770682 token`
- Öne çıkan dosyalar:
  - `src/cli/qmd.ts`
  - `src/collections.ts`
  - `README.md`
  - `docs/SYNTAX.md`

### Alınan pattern
- `qmd search --json` ile deterministic local arama
- collection yönetimi (`collection add --name ...`)
- query/query-search ayrımı (LLM'siz hızlı search modu)

### SMART-AI'a uygulama
- Klonlamadan, VPS'te kurulu `qmd` binary kullanan tool entegrasyonu tamamlandı.
- Varsayılan olarak `qmd search` (LLM bağımsız, hızlı) kullanılıyor.

---

## Sonuç Kararı
- **Birebir kod taşıma:** Hayır
- **Pattern-level entegrasyon:** Evet

Bu koşumda pattern’ler doğrudan ürün koduna taşındı:
- `qmd_search` tool + planner/verifier/deep-research entegrasyonu
- Memory hotness + retrieval telemetry
- QMD collection auto-bootstrap + timeout/fallback güvenliği
