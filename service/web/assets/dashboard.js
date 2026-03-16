const STORAGE_KEY = 'smart_ai_ui_settings_v1';

function nowIso() {
  return new Date().toLocaleString('tr-TR');
}

function log(message) {
  const box = document.getElementById('logBox');
  if (!box) return;
  box.textContent = `[${nowIso()}] ${message}\n` + box.textContent;
}

function getSettings() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) {
    return {
      baseUrl: window.location.origin,
      apiKey: '',
      tenantId: 'tenant-a'
    };
  }

  try {
    return JSON.parse(saved);
  } catch {
    return {
      baseUrl: window.location.origin,
      apiKey: '',
      tenantId: 'tenant-a'
    };
  }
}

function setSettings(settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function authHeaders(settings) {
  return {
    authorization: `Bearer ${settings.apiKey}`,
    'x-tenant-id': settings.tenantId,
    'content-type': 'application/json'
  };
}

async function safeFetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();

  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }

  return body;
}

function fillSettingsForm(settings) {
  document.getElementById('baseUrl').value = settings.baseUrl;
  document.getElementById('apiKey').value = settings.apiKey;
  document.getElementById('tenantId').value = settings.tenantId;
}

function readSettingsForm() {
  return {
    baseUrl: document.getElementById('baseUrl').value.trim().replace(/\/$/, ''),
    apiKey: document.getElementById('apiKey').value.trim(),
    tenantId: document.getElementById('tenantId').value.trim()
  };
}

function renderMcpTable(servers = {}) {
  const tbody = document.getElementById('mcpTableBody');
  tbody.innerHTML = '';

  for (const [serverId, server] of Object.entries(servers)) {
    const tr = document.createElement('tr');

    const err = server.lastError ? server.lastError.slice(0, 80) : '—';
    tr.innerHTML = `
      <td>${serverId}</td>
      <td>${server.circuitState}</td>
      <td>${server.totalCalls}</td>
      <td>${server.totalFailures}</td>
      <td>${server.avgLatencyMs} / ${server.p95LatencyMs}</td>
      <td>${err}</td>
    `;

    tbody.appendChild(tr);
  }
}

async function loadDashboard(settings) {
  if (!settings.apiKey || !settings.tenantId) {
    throw new Error('API Key ve Tenant ID zorunlu.');
  }

  const health = await safeFetchJson(`${settings.baseUrl}/health`);
  document.getElementById('serviceStatus').textContent = `${health.ok ? 'UP' : 'DOWN'} | ${health.service} | ${health.env}`;

  const mcp = await safeFetchJson(`${settings.baseUrl}/v1/mcp/health`, {
    headers: authHeaders(settings)
  });
  document.getElementById('mcpGlobal').textContent = `calls=${mcp.global.totalCalls}, failures=${mcp.global.totalFailures}, avg=${mcp.global.avgLatencyMs}ms`;
  renderMcpTable(mcp.servers);

  const memory = await safeFetchJson(`${settings.baseUrl}/v1/memory/stats`, {
    headers: authHeaders(settings)
  });
  document.getElementById('memoryStats').textContent = `items=${memory.items}, avg_latency=${memory.retrieval?.avgLatencyMs ?? 0}ms`;

  const ragDocs = await safeFetchJson(`${settings.baseUrl}/v1/rag/documents`, {
    headers: authHeaders(settings)
  });
  const docs = Array.isArray(ragDocs.documents) ? ragDocs.documents.length : 0;
  document.getElementById('ragStats').textContent = `documents=${docs}`;

  log('Dashboard güncellendi.');
}

async function flushMcp(settings) {
  await safeFetchJson(`${settings.baseUrl}/v1/mcp/flush`, {
    method: 'POST',
    headers: authHeaders(settings)
  });

  log('MCP health snapshot flush tetiklendi.');
}

function setStatus(message, isError = false) {
  const node = document.getElementById('settingsStatus');
  node.textContent = message;
  node.style.color = isError ? 'var(--danger)' : 'var(--muted)';
}

async function init() {
  const settings = getSettings();
  fillSettingsForm(settings);

  document.getElementById('saveSettings').addEventListener('click', () => {
    const next = readSettingsForm();
    setSettings(next);
    setStatus('Ayarlar kaydedildi.');
    log('Ayarlar kaydedildi.');
  });

  document.getElementById('refreshAll').addEventListener('click', async () => {
    const next = readSettingsForm();
    setSettings(next);

    try {
      await loadDashboard(next);
      setStatus('Yenileme başarılı.');
    } catch (error) {
      setStatus(String(error), true);
      log(`Hata: ${String(error)}`);
    }
  });

  document.getElementById('flushMcp').addEventListener('click', async () => {
    const next = readSettingsForm();
    setSettings(next);

    try {
      await flushMcp(next);
      await loadDashboard(next);
      setStatus('MCP flush başarılı.');
    } catch (error) {
      setStatus(String(error), true);
      log(`Hata: ${String(error)}`);
    }
  });

  try {
    await loadDashboard(settings);
    setStatus('Dashboard hazır.');
  } catch (error) {
    setStatus(String(error), true);
    log(`Hata: ${String(error)}`);
  }
}

void init();
