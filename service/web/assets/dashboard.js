const SETTINGS_STORAGE_KEY = 'smart_ai_ui_dashboard_settings_v2';
const SESSION_STORAGE_KEY = 'smart_ai_ui_session_token_v1';
const SESSION_META_STORAGE_KEY = 'smart_ai_ui_session_meta_v1';

function nowIso() {
  return new Date().toLocaleString('tr-TR');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function log(message) {
  const box = document.getElementById('logBox');
  if (!box) return;
  box.textContent = `[${nowIso()}] ${message}\n` + box.textContent;
}

function defaultSettings() {
  return {
    baseUrl: window.location.origin,
    tenantId: 'tenant-a'
  };
}

function getSettings() {
  const saved = localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (!saved) {
    return defaultSettings();
  }

  try {
    return { ...defaultSettings(), ...JSON.parse(saved) };
  } catch {
    return defaultSettings();
  }
}

function setSettings(settings) {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

function getSessionToken() {
  return sessionStorage.getItem(SESSION_STORAGE_KEY) ?? '';
}

function setSessionToken(token) {
  if (!token) {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    return;
  }

  sessionStorage.setItem(SESSION_STORAGE_KEY, token);
}

function getSessionMeta() {
  const raw = sessionStorage.getItem(SESSION_META_STORAGE_KEY);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function setSessionMeta(meta) {
  if (!meta) {
    sessionStorage.removeItem(SESSION_META_STORAGE_KEY);
    return;
  }

  sessionStorage.setItem(SESSION_META_STORAGE_KEY, JSON.stringify(meta));
}

function authHeaders(settings) {
  const token = getSessionToken();
  if (!token) {
    throw new Error('Önce API Key ile oturum açın.');
  }

  return {
    authorization: `Bearer ${token}`,
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

async function maybeRefreshSession(settings, minRemainingSeconds = 90) {
  const token = getSessionToken();
  if (!token) return;

  const sessionMeta = getSessionMeta();
  const expiresAtMs = Date.parse(String(sessionMeta?.expiresAt ?? ''));
  const secondsLeft = Number.isFinite(expiresAtMs) ? Math.floor((expiresAtMs - Date.now()) / 1000) : 0;

  if (secondsLeft > minRemainingSeconds) {
    return;
  }

  const refreshed = await safeFetchJson(`${settings.baseUrl}/ui/session/refresh`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-tenant-id': settings.tenantId,
      'content-type': 'application/json'
    }
  });

  setSessionToken(refreshed?.token ?? '');
  setSessionMeta({
    expiresAt: refreshed?.expiresAt,
    idleExpiresAt: refreshed?.idleExpiresAt,
    lastSeenAt: refreshed?.lastSeenAt
  });
  log('Dashboard session refreshed.');
}

function fillSettingsForm(settings) {
  document.getElementById('baseUrl').value = settings.baseUrl;
  document.getElementById('tenantId').value = settings.tenantId;
}

function readSettingsForm() {
  return {
    baseUrl: document.getElementById('baseUrl').value.trim().replace(/\/$/, ''),
    tenantId: document.getElementById('tenantId').value.trim()
  };
}

function renderMcpTable(servers = {}) {
  const tbody = document.getElementById('mcpTableBody');
  tbody.innerHTML = '';

  for (const [serverId, server] of Object.entries(servers)) {
    const tr = document.createElement('tr');

    const err = server.lastError ? server.lastError.slice(0, 100) : '—';
    tr.innerHTML = `
      <td>${escapeHtml(serverId)}</td>
      <td>${escapeHtml(server.circuitState)}</td>
      <td>${escapeHtml(server.totalCalls)}</td>
      <td>${escapeHtml(server.totalFailures)}</td>
      <td>${escapeHtml(server.avgLatencyMs)} / ${escapeHtml(server.p95LatencyMs)}</td>
      <td>${escapeHtml(err)}</td>
    `;

    tbody.appendChild(tr);
  }
}

function renderSecurityTable(events = []) {
  const tbody = document.getElementById('securityTableBody');
  tbody.innerHTML = '';

  if (!events.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="4">Kayıt yok</td>';
    tbody.appendChild(tr);
    return;
  }

  for (const event of events) {
    const tr = document.createElement('tr');
    const detail = event.details ? JSON.stringify(event.details) : '—';

    tr.innerHTML = `
      <td>${escapeHtml(new Date(event.timestamp).toLocaleString('tr-TR'))}</td>
      <td>${escapeHtml(event.type)}</td>
      <td>${escapeHtml(event.ip ?? '—')}</td>
      <td>${escapeHtml(detail.slice(0, 140))}</td>
    `;

    tbody.appendChild(tr);
  }
}

function parseAllowedModelsInput(value) {
  return [...new Set(String(value || '')
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean))];
}

function renderModelPolicy(policy) {
  const summary = document.getElementById('modelPolicySummary');
  const status = document.getElementById('policyStatus');
  const select = document.getElementById('policyDefaultModel');
  const textarea = document.getElementById('policyAllowedModels');

  const deploymentAllowed = Array.isArray(policy?.deployment_allowed_models) ? policy.deployment_allowed_models : [];
  const allowed = Array.isArray(policy?.allowed_models) ? policy.allowed_models : [];
  const source = policy?.source ?? 'deployment';
  const policyStatus = policy?.policy_status ?? 'inherited';
  const defaultModel = policy?.default_model ?? '';

  summary.textContent = `source=${source}, status=${policyStatus}, default=${defaultModel || '—'}, models=${allowed.length}`;
  status.value = `${source} / ${policyStatus}`;
  textarea.value = allowed.join('\n');

  select.innerHTML = '';
  for (const model of deploymentAllowed) {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = model;
    select.appendChild(option);
  }

  if (defaultModel) {
    select.value = defaultModel;
  }

  if (!select.value && deploymentAllowed[0]) {
    select.value = deploymentAllowed[0];
  }
}

async function loadModelPolicy(settings) {
  await maybeRefreshSession(settings);

  const policy = await safeFetchJson(`${settings.baseUrl}/v1/model-policy`, {
    headers: authHeaders(settings)
  });

  renderModelPolicy(policy);
  return policy;
}

async function saveModelPolicy(settings) {
  await maybeRefreshSession(settings);

  const allowedModels = parseAllowedModelsInput(document.getElementById('policyAllowedModels').value);
  const defaultModel = document.getElementById('policyDefaultModel').value;

  if (!allowedModels.length) {
    throw new Error('En az bir allowed model gerekli.');
  }

  const policy = await safeFetchJson(`${settings.baseUrl}/v1/model-policy`, {
    method: 'PUT',
    headers: authHeaders(settings),
    body: JSON.stringify({ allowedModels, defaultModel })
  });

  renderModelPolicy(policy);
  log(`Tenant model policy güncellendi. default=${policy.default_model}`);
}

async function resetModelPolicy(settings) {
  await maybeRefreshSession(settings);

  const policy = await safeFetchJson(`${settings.baseUrl}/v1/model-policy`, {
    method: 'DELETE',
    headers: authHeaders(settings)
  });

  renderModelPolicy(policy);
  log('Tenant model policy deployment defaultlarına döndürüldü.');
}

async function loadDashboard(settings) {
  if (!settings.tenantId) {
    throw new Error('Tenant ID zorunlu.');
  }

  await maybeRefreshSession(settings);

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

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const security = await safeFetchJson(`${settings.baseUrl}/v1/security/events?limit=20&since=${encodeURIComponent(since)}`, {
    headers: authHeaders(settings)
  });
  const events = Array.isArray(security.data) ? security.data : [];
  document.getElementById('securityEvents').textContent = `events=${events.length}`;
  renderSecurityTable(events);

  await loadModelPolicy(settings);
  log('Dashboard güncellendi.');
}

async function flushMcp(settings) {
  await maybeRefreshSession(settings);

  await safeFetchJson(`${settings.baseUrl}/v1/mcp/flush`, {
    method: 'POST',
    headers: authHeaders(settings)
  });

  log('MCP health snapshot flush tetiklendi.');
}

async function signIn(settings) {
  const apiKey = document.getElementById('apiKey').value.trim();
  if (!apiKey) {
    throw new Error('API Key gerekli.');
  }

  const data = await safeFetchJson(`${settings.baseUrl}/ui/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey, tenantId: settings.tenantId })
  });

  setSessionToken(data?.token ?? '');
  setSessionMeta({
    expiresAt: data?.expiresAt,
    idleExpiresAt: data?.idleExpiresAt,
    lastSeenAt: data?.lastSeenAt
  });
  document.getElementById('apiKey').value = '';
  log('Dashboard oturumu açıldı.');
  return data;
}

async function signOut(settings) {
  const token = getSessionToken();
  if (!token) {
    setStatus('Aktif oturum yok.');
    return;
  }

  try {
    await safeFetchJson(`${settings.baseUrl}/ui/session/revoke`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'x-tenant-id': settings.tenantId,
        'content-type': 'application/json'
      }
    });
  } finally {
    setSessionToken('');
    setSessionMeta(null);
  }

  log('Dashboard oturumu kapatıldı.');
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
    setStatus('Ayarlar kaydedildi. API Key saklanmaz.');
    log('Ayarlar kaydedildi.');
  });

  document.getElementById('signIn').addEventListener('click', async () => {
    const next = readSettingsForm();
    setSettings(next);

    try {
      await signIn(next);
      await loadDashboard(next);
      setStatus('Dashboard oturumu hazır.');
    } catch (error) {
      setStatus(String(error), true);
      log(`Hata: ${String(error)}`);
    }
  });

  document.getElementById('signOut').addEventListener('click', async () => {
    const next = readSettingsForm();
    setSettings(next);

    try {
      await signOut(next);
      setStatus('Oturum kapatıldı.');
    } catch (error) {
      setStatus(String(error), true);
      log(`Hata: ${String(error)}`);
    }
  });

  document.getElementById('refreshAll').addEventListener('click', async () => {
    const next = readSettingsForm();
    setSettings(next);

    try {
      await loadDashboard(next);
      setStatus('Dashboard güncellendi.');
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
      setStatus('MCP flush tetiklendi.');
    } catch (error) {
      setStatus(String(error), true);
      log(`Hata: ${String(error)}`);
    }
  });

  document.getElementById('savePolicy').addEventListener('click', async () => {
    const next = readSettingsForm();
    setSettings(next);

    try {
      await saveModelPolicy(next);
      setStatus('Tenant model policy kaydedildi.');
    } catch (error) {
      setStatus(String(error), true);
      log(`Hata: ${String(error)}`);
    }
  });

  document.getElementById('resetPolicy').addEventListener('click', async () => {
    const next = readSettingsForm();
    setSettings(next);

    try {
      await resetModelPolicy(next);
      setStatus('Tenant model policy deployment defaultlarına döndü.');
    } catch (error) {
      setStatus(String(error), true);
      log(`Hata: ${String(error)}`);
    }
  });

  if (!getSessionToken()) {
    setStatus('Önce API Key ile oturum açın.');
    return;
  }

  try {
    await loadDashboard(settings);
    setStatus('Dashboard hazır.');
  } catch {
    setStatus('Oturum süresi dolmuş olabilir. Tekrar giriş yapın.', false);
    setSessionToken('');
    setSessionMeta(null);
  }
}

void init();
