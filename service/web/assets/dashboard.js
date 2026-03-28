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

function setSessionCapabilities(message, isError = false) {
  const node = document.getElementById('sessionCapabilities');
  if (!node) return;
  node.textContent = message;
  node.style.color = isError ? 'var(--danger)' : 'var(--muted)';
}

function setAdminControlsEnabled(enabled) {
  for (const id of [
    'flushMcp',
    'savePolicy',
    'resetPolicy',
    'policyDefaultModel',
    'policyAllowedModels',
    'saveRemotePolicy',
    'resetRemotePolicy',
    'remotePolicyMode',
    'remotePolicyAllowedHosts',
    'revokeOtherSessions'
  ]) {
    const node = document.getElementById(id);
    if (node) {
      node.disabled = !enabled;
    }
  }
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
    sessionId: refreshed?.sessionId,
    expiresAt: refreshed?.expiresAt,
    idleExpiresAt: refreshed?.idleExpiresAt,
    lastSeenAt: refreshed?.lastSeenAt,
    principalName: refreshed?.principalName,
    scopes: refreshed?.scopes
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

function renderUiSessionsTable(sessions = []) {
  const tbody = document.getElementById('uiSessionsTableBody');
  tbody.innerHTML = '';

  if (!sessions.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="7">Aktif UI session yok</td>';
    tbody.appendChild(tr);
    return;
  }

  for (const session of sessions) {
    const tr = document.createElement('tr');
    const sessionLabel = session.is_current
      ? `${session.session_id.slice(0, 8)}… <span class="badge success">current</span>`
      : `${session.session_id.slice(0, 8)}…`;
    const scopes = Array.isArray(session.scopes) ? session.scopes.join(', ') : '—';
    const status = session.user_agent_bound ? 'UA-bound' : 'Token-only';

    tr.innerHTML = `
      <td>${sessionLabel}</td>
      <td>${escapeHtml(session.principal_name ?? 'unknown')}</td>
      <td>${escapeHtml(scopes)}</td>
      <td>${escapeHtml(new Date(session.last_seen_at).toLocaleString('tr-TR'))}</td>
      <td>${escapeHtml(new Date(session.expires_at).toLocaleString('tr-TR'))}</td>
      <td>${escapeHtml(status)}</td>
      <td>
        <button class="secondary compact revoke-session-btn" data-session-id="${escapeHtml(session.session_id)}" ${session.is_current ? 'disabled' : ''}>
          Kapat
        </button>
      </td>
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
  const allowed = Array.isArray(policy?.allowed_models) ? policy?.allowed_models : [];
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

function renderRemotePolicy(policy) {
  const summary = document.getElementById('remotePolicySummary');
  const mode = document.getElementById('remotePolicyMode');
  const status = document.getElementById('remotePolicyStatus');
  const textarea = document.getElementById('remotePolicyAllowedHosts');

  const source = policy?.source ?? 'deployment';
  const policyStatus = policy?.policy_status ?? 'inherited';
  const selectedMode = policy?.mode ?? 'preview_only';
  const allowedHosts = Array.isArray(policy?.allowed_hosts) ? policy.allowed_hosts : [];

  summary.textContent = `source=${source}, status=${policyStatus}, mode=${selectedMode}, hosts=${allowedHosts.length}`;
  if (status) {
    status.value = `${source} / ${policyStatus}`;
  }
  mode.value = selectedMode;
  textarea.value = allowedHosts.join('\n');
}

function applyAuthContext(context) {
  const permissions = context?.permissions ?? {};
  const scopes = Array.isArray(context?.scopes) ? context.scopes.join(', ') : '—';
  const principalName = context?.principal_name ?? 'unknown';
  const adminEnabled = Boolean(permissions.admin);

  setAdminControlsEnabled(adminEnabled);
  setSessionCapabilities(
    `Yetki bilgisi: ${principalName} | scopes=${scopes} | admin=${adminEnabled ? 'evet' : 'hayır'}`,
    false
  );

  if (!adminEnabled) {
    document.getElementById('uiSessionsSummary').textContent = 'admin gerekli';
    renderUiSessionsTable([]);
    log('Bu oturum admin yetkisine sahip değil; model policy, remote policy, session control ve MCP flush kontrolleri salt okunur moda alındı.');
  }
}

async function loadAuthContext(settings) {
  await maybeRefreshSession(settings);

  const context = await safeFetchJson(`${settings.baseUrl}/v1/auth/context`, {
    headers: authHeaders(settings)
  });

  applyAuthContext(context);
  return context;
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

async function loadRemotePolicy(settings) {
  await maybeRefreshSession(settings);

  const policy = await safeFetchJson(`${settings.baseUrl}/v1/rag/remote-policy`, {
    headers: authHeaders(settings)
  });

  renderRemotePolicy(policy);
  return policy;
}

async function saveRemotePolicy(settings) {
  await maybeRefreshSession(settings);

  const mode = document.getElementById('remotePolicyMode').value;
  const allowedHosts = parseAllowedModelsInput(document.getElementById('remotePolicyAllowedHosts').value);

  const policy = await safeFetchJson(`${settings.baseUrl}/v1/rag/remote-policy`, {
    method: 'PUT',
    headers: authHeaders(settings),
    body: JSON.stringify({ mode, allowedHosts })
  });

  renderRemotePolicy(policy);
  log(`Remote source policy güncellendi. mode=${policy.mode}, hosts=${policy.allowed_hosts?.length ?? 0}`);
}

async function resetRemotePolicy(settings) {
  await maybeRefreshSession(settings);

  const policy = await safeFetchJson(`${settings.baseUrl}/v1/rag/remote-policy`, {
    method: 'DELETE',
    headers: authHeaders(settings)
  });

  renderRemotePolicy(policy);
  log('Remote source policy deployment defaultlarına döndürüldü.');
}

async function loadUiSessions(settings) {
  await maybeRefreshSession(settings);

  const response = await safeFetchJson(`${settings.baseUrl}/v1/ui/sessions?limit=20`, {
    headers: authHeaders(settings)
  });

  const sessions = Array.isArray(response?.data) ? response.data : [];
  document.getElementById('uiSessionsSummary').textContent = `active=${sessions.length}`;
  renderUiSessionsTable(sessions);
  return sessions;
}

async function revokeUiSession(settings, sessionId) {
  await maybeRefreshSession(settings);

  await safeFetchJson(`${settings.baseUrl}/v1/ui/sessions/${encodeURIComponent(sessionId)}/revoke`, {
    method: 'POST',
    headers: {
      ...authHeaders(settings),
      origin: window.location.origin
    }
  });

  log(`UI session kapatıldı: ${sessionId}`);
}

async function revokeOtherSessions(settings) {
  await maybeRefreshSession(settings);

  const response = await safeFetchJson(`${settings.baseUrl}/v1/ui/sessions/revoke-all`, {
    method: 'POST',
    headers: {
      ...authHeaders(settings),
      origin: window.location.origin
    },
    body: JSON.stringify({ exceptCurrent: true })
  });

  log(`Diğer UI oturumları kapatıldı. revoked=${response?.revoked_count ?? 0}`);
  return response;
}

async function loadDashboard(settings) {
  if (!settings.tenantId) {
    throw new Error('Tenant ID zorunlu.');
  }

  await maybeRefreshSession(settings);
  const authContext = await loadAuthContext(settings);

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
  const docs = Array.isArray(ragDocs.data) ? ragDocs.data.length : 0;
  document.getElementById('ragStats').textContent = `documents=${docs}`;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const security = await safeFetchJson(`${settings.baseUrl}/v1/security/events?limit=20&since=${encodeURIComponent(since)}`, {
    headers: authHeaders(settings)
  });
  const events = Array.isArray(security.data) ? security.data : [];
  document.getElementById('securityEvents').textContent = `events=${events.length}`;
  renderSecurityTable(events);

  await loadModelPolicy(settings);
  await loadRemotePolicy(settings);
  if (authContext?.permissions?.admin) {
    await loadUiSessions(settings);
  }
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
    sessionId: data?.sessionId,
    expiresAt: data?.expiresAt,
    idleExpiresAt: data?.idleExpiresAt,
    lastSeenAt: data?.lastSeenAt,
    principalName: data?.principalName,
    scopes: data?.scopes
  });
  document.getElementById('apiKey').value = '';
  if (Array.isArray(data?.scopes)) {
    setSessionCapabilities(`Yetki bilgisi: ${data?.principalName ?? 'unknown'} | scopes=${data.scopes.join(', ')}`);
  }
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
    setAdminControlsEnabled(false);
    setSessionCapabilities('Yetki bilgisi: aktif oturum yok.');
    document.getElementById('uiSessionsSummary').textContent = '—';
    document.getElementById('remotePolicySummary').textContent = '—';
    renderUiSessionsTable([]);
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
  setAdminControlsEnabled(false);
  setSessionCapabilities('Yetki bilgisi: aktif oturum yok.');
  document.getElementById('uiSessionsSummary').textContent = '—';
  document.getElementById('remotePolicySummary').textContent = '—';
  renderUiSessionsTable([]);

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

  document.getElementById('revokeOtherSessions').addEventListener('click', async () => {
    const next = readSettingsForm();
    setSettings(next);

    if (!window.confirm('Mevcut oturumu açık tutup diğer dashboard/chat oturumlarını kapatayım mı?')) {
      return;
    }

    try {
      await revokeOtherSessions(next);
      await loadUiSessions(next);
      setStatus('Diğer UI oturumları kapatıldı.');
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

  document.getElementById('saveRemotePolicy').addEventListener('click', async () => {
    const next = readSettingsForm();
    setSettings(next);

    try {
      await saveRemotePolicy(next);
      setStatus('Remote source policy kaydedildi.');
    } catch (error) {
      setStatus(String(error), true);
      log(`Hata: ${String(error)}`);
    }
  });

  document.getElementById('resetRemotePolicy').addEventListener('click', async () => {
    const next = readSettingsForm();
    setSettings(next);

    try {
      await resetRemotePolicy(next);
      setStatus('Remote source policy deployment defaultlarına döndü.');
    } catch (error) {
      setStatus(String(error), true);
      log(`Hata: ${String(error)}`);
    }
  });

  document.getElementById('uiSessionsTableBody').addEventListener('click', async (event) => {
    const button = event.target.closest('.revoke-session-btn');
    if (!button || button.disabled) {
      return;
    }

    const sessionId = button.dataset.sessionId;
    if (!sessionId) {
      return;
    }

    if (!window.confirm(`Session ${sessionId.slice(0, 8)}… kapatılsın mı?`)) {
      return;
    }

    const next = readSettingsForm();
    setSettings(next);

    try {
      await revokeUiSession(next, sessionId);
      await loadUiSessions(next);
      setStatus('Seçilen UI oturumu kapatıldı.');
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
    setAdminControlsEnabled(false);
    setSessionCapabilities('Yetki bilgisi: aktif oturum yok.', false);
  }
}

void init();
