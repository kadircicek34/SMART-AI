# OpenBB Analysis — 2026-03-16 (mcporter + github-readonly + repomix)

## Araçlar
- `mcporter call github-readonly.list_commits`
- `mcporter call github-readonly.list_releases`
- `mcporter call repomix.pack_remote_repository`

## Kaynak Repo
- Repo: `https://github.com/OpenBB-finance/OpenBB`
- Son commit: `1788e77fe16fd1af84c1ff7e645340b31dfceb67`
- Commit mesajı: `[BugFix] Remove unnecessary eval() calls in script_parser.py (#7403)`
- Son release: `v4.7.0`

## Repomix Özeti
- Focus pack: `1180 file`, `2498841 token`
- Öne çıkan çekirdek dosyalar:
  - `openbb_platform/core/openbb_core/provider/registry.py`
  - `openbb_platform/core/openbb_core/provider/query_executor.py`
  - `openbb_platform/core/openbb_core/provider/abstract/fetcher.py`
  - `openbb_platform/core/openbb_core/provider/utils/errors.py`
  - provider modelleri (`.../models/equity_quote.py`, `.../models/company_news.py`)

## Kritik Pattern Bulguları
1. **Provider Registry + Query Executor**
   - Bir model için çok provider yönetimi
   - Credentials filtering + provider capabilities
2. **Fetcher Lifecycle (transform_query → extract_data → transform_data)**
   - Normalize edilmiş veri modeli
   - Provider farklarını soyutlama
3. **Typed standard models**
   - `EquityQuote`, `CompanyNews` benzeri ortak model kontratı
4. **Error modeling**
   - unauthorized/empty data gibi sınıflı hata yaklaşımı

## SMART-AI için alınan karar
- Birebir kod taşıma: **Hayır**
- Pattern-level uygulama: **Evet**

## Bu koşumda uygulananlar
- `financial_deep_search` OpenBB tarzı provider fallback mantığına geçirildi:
  - Stooq quote provider
  - AlphaVantage quote provider
- Multi-provider quote harmonization ve spread hesaplama eklendi.
- Financial query parser çoklu sembol desteği ile güçlendirildi.
- Finansal çağrılar için kısa TTL quote cache eklendi.
- Yeni testler eklendi (`service/tests/tools/financial.test.ts`).

## Sonuç
OpenBB’den gelen en yüksek ROI pattern, SMART-AI finansal tool runtime’ında provider-agnostic ve fallback-odaklı bir tasarım oldu; üretime bu yaklaşım taşındı.
