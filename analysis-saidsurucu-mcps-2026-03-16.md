# Analysis — saidsurucu MCP Servers (2026-03-16)

## Kapsam
`mcporter` üzerinden şu MCP/readonly akışı kullanıldı:
- `github-readonly.list_commits`
- `github-readonly.list_releases`
- `repomix.pack_remote_repository`
- canlı erişim doğrulaması için `mcporter list/call <serverUrl>`

İncelenen repolar:
1. `saidsurucu/mevzuat-mcp`
2. `saidsurucu/borsa-mcp`
3. `saidsurucu/yargi-mcp`

## 1) mevzuat-mcp
- Son commit: `2bc7b28a5628` (2026-03-15)
- Release: `v1.0.0`
- Repomix: `25 file`, `57,800 token`
- Remote MCP URL: `https://mevzuat.surucu.dev/mcp`
- Ana gözlem: mevzuat türüne göre ayrışmış tool seti + unified search_within patterni.
- SMART-AI için alınan pattern:
  - Türk mevzuat sorgularını doğrudan domain MCP'ye route etmek
  - normal web-search yerine kanun/metin odaklı kaynak kullanmak

## 2) borsa-mcp
- Son commit: `09ffcf7fc2e0` (2026-03-09)
- Repomix: `62 file`, `514,866 token`
- Remote MCP URL: `https://borsamcp.fastmcp.app/mcp`
- Ana gözlem: unified market router + market-aware tool isimleri (`search_symbol`, `get_profile`, `get_quick_info` ...)
- SMART-AI için alınan pattern:
  - market literal ile route (bist/us/fund/crypto)
  - ilk aşama symbol resolution, ikinci aşama profile/metric enrichment

## 3) yargi-mcp
- Son commit: `036e49a92828` (2026-03-09)
- Release: `v0.2.0`
- Repomix: `81 file`, `186,244 token`
- Remote MCP URL: `https://yargimcp.fastmcp.app/mcp`
- Ana gözlem: çok kurumlu hukuki arama + unified search fonksiyonları + fallback araçları.
- SMART-AI için alınan pattern:
  - case-law sorgularında `search_emsal_detailed_decisions` primary
  - empty result durumunda `search_bedesten_unified` fallback

## Uygulama Kararı
- Birebir kod taşıma: **Hayır**
- MCP olarak entegrasyon: **Evet**
- Eklendi:
  - `mevzuat_mcp_search`
  - `borsa_mcp_search`
  - `yargi_mcp_search`
- Entegrasyon katmanı: `service/tools/tr-mcp-search.ts`
- Çalıştırma yöntemi: SMART-AI içinden `mcporter call <remoteMcpUrl.tool>`

## Operasyonel Not
- Bu entegrasyonlar remote MCP bağımlı olduğu için timeout/retry/fallback davranışı önemlidir.
- Yargı aramada fallback davranışı özellikle canlı ortamda boş sonuç yönetimi için aktifleştirildi (`YARGI_MCP_FALLBACK_ENABLED=true`).
