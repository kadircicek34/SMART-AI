# SMART-AI External Repo Findings (mcporter + github-readonly + repomix)

## Yöntem
Bu doküman, `mcporter` üzerinden şu MCP araçlarıyla oluşturuldu:
- `github-readonly` (latest commit / release / repo meta)
- `repomix` (`pack_remote_repository`) ile yapı ve sinyal taraması

Analizlenen repolar:
1. `crewAIInc/crewAI`
2. `langflow-ai/openrag`
3. `langchain-ai/open_deep_research`
4. `QwenLM/Qwen-Agent`
5. `bytedance/deer-flow`
6. `NevaMind-AI/memU`

## Executive karar
- **Birebir kod taşıma yok** (stack + bakım + bağımlılık riski)
- **Pattern-level sentez var** (yüksek ROI davranışları alındı)
- Bu koşumda üretime alınan pattern’ler:
  - Verifier source-diversity kalite kapısı
  - Orchestrator repeated-pass loop guard
  - Deep-research query budget + concurrency + partial-failure tolerance

## Repo bazlı öneriler

### 1) CrewAI
- Güçlü yan: plan/execute disiplini, tool governance, guardrail yaklaşımı
- SMART-AI için öneri:
  - Tool policy + fail-fast + controlled retry çizgisini sürdür
  - Geniş tool setine geçmeden önce kalite kapılarını artır
- Birebir alma: **Hayır**

### 2) OpenRAG
- Güçlü yan: ingest + retrieval ürünleşmesi, connector-first RAG yaklaşımı
- SMART-AI için öneri:
  - RAG store’u vector backend’e (OpenSearch/Qdrant) çıkarılabilir
  - URL ingest hardening (SSRF allowlist) bir sonraki adım
- Birebir alma: **Kısmi pattern**

### 3) Open Deep Research
- Güçlü yan: araştırma workflow disiplini, concurrency/iteration limitleri
- SMART-AI için öneri:
  - query budget + concurrent unit limitlerini config’den yönet
  - düşük kanıtta ek research pass stratejisi
- Birebir alma: **Hayır, workflow pattern alınır**

### 4) Qwen-Agent
- Güçlü yan: tool schema/pragmatik runtime, MCP manager yaklaşımı
- SMART-AI için öneri:
  - tool metadata + execution telemetry katmanı
  - tool adapter standardizasyonunu koru
- Birebir alma: **Hayır**

### 5) Deer-Flow
- Güçlü yan: loop detection, tool error middleware, runtime güvenlik katmanları
- SMART-AI için öneri:
  - loop guard + error degradation detection
  - tool call telemetry ile otomatik kalite alarmı
- Birebir alma: **Hayır, middleware pattern alınır**

### 6) memU
- Güçlü yan: memory retrieval karar pipeline’ı, memory type modeli
- SMART-AI için öneri:
  - (Opsiyonel) gelecekte memory katmanı açılacaksa pre-retrieval decision yaklaşımı kullanılmalı
- Birebir alma: **Şimdilik hayır**

## Sonuç
SMART-AI için doğru yön: **kopya framework değil, entegre edilebilir pattern’lerle yalın ama üretim dayanıklı çekirdek**.
