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
    'saveDeliveryPolicy',
    'resetDeliveryPolicy',
    'deliveryPolicyMode',
    'deliveryPolicyAllowedTargets',
    'exportSecurity',
    'securityDeliveryUrl',
    'securityDeliveryMode',
    'securityDeliveryWindowHours',
    'securityDeliveryLimit',
    'previewSecurityDelivery',
    'deliverSecurityExport',
    'rotateSecuritySigningKey',
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

function renderSecuritySigningTable(keys = []) {
  const tbody = document.getElementById('securitySigningTableBody');
  tbody.innerHTML = '';

  if (!keys.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="6">Henüz signing key kaydı yok</td>';
    tbody.appendChild(tr);
    return;
  }

  for (const key of keys) {
    const tr = document.createElement('tr');
    const lifecycle = key.lifecycle ?? {};
    const statusBits = [key.status === 'active' ? `${key.status} <span class="badge success">live</span>` : key.status];
    if (lifecycle.expired) {
      statusBits.push('<span class="badge danger">expired</span>');
    } else if (lifecycle.rotation_due) {
      statusBits.push('<span class="badge warn">rotate</span>');
    } else if (lifecycle.expiring_soon) {
      statusBits.push('<span class="badge warn">warn</span>');
    }
    if (lifecycle.retention_expired) {
      statusBits.push('<span class="badge warn">prune</span>');
    }
    const rotateDue = lifecycle.rotation_due_at ? new Date(lifecycle.rotation_due_at).toLocaleString('tr-TR') : '—';
    const expireOrRetain = lifecycle.expires_at ?? lifecycle.retained_until;
    tr.innerHTML = `
      <td>${statusBits.join(' ')}</td>
      <td>${escapeHtml(key.key_id)}</td>
      <td>${escapeHtml(key.algorithm)}</td>
      <td>${escapeHtml(String(key.fingerprint ?? '—').slice(0, 22))}</td>
      <td>${escapeHtml(rotateDue)}</td>
      <td>${escapeHtml(expireOrRetain ? new Date(expireOrRetain).toLocaleString('tr-TR') : '—')}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderSecurityDeliveriesTable(deliveries = []) {
  const tbody = document.getElementById('securityDeliveryTableBody');
  tbody.innerHTML = '';

  if (!deliveries.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="7">Henüz delivery yok</td>';
    tbody.appendChild(tr);
    return;
  }

  for (const delivery of deliveries) {
    const tr = document.createElement('tr');
    const timestamp = delivery.completed_at ?? delivery.updated_at ?? delivery.requested_at;
    const retryMeta = [`attempt=${delivery.attempt_count ?? 0}/${delivery.max_attempts ?? 1}`];
    if (Number(delivery.redrive_count ?? 0) > 0) {
      retryMeta.push(`redrive=${delivery.redrive_count}`);
    }
    if (delivery.source_delivery_id) {
      retryMeta.push(`source=${String(delivery.source_delivery_id).slice(0, 8)}…`);
    }
    if (delivery.next_attempt_at) {
      retryMeta.push(`next=${new Date(delivery.next_attempt_at).toLocaleString('tr-TR')}`);
    }
    if (delivery.dead_lettered_at) {
      retryMeta.push('dead-letter');
    }
    const note = delivery.failure_reason ?? delivery.response_excerpt ?? retryMeta.join(' | ');
    const actionHtml =
      delivery.status === 'dead_letter'
        ? `<button class="secondary compact redrive-delivery-btn" data-delivery-id="${escapeHtml(delivery.delivery_id)}">Tekrar Dene</button>`
        : '<span class="muted">—</span>';
    tr.innerHTML = `
      <td>${escapeHtml(new Date(timestamp).toLocaleString('tr-TR'))}</td>
      <td>${escapeHtml(delivery.status)}<br /><span class="muted">${escapeHtml(delivery.mode ?? 'sync')}</span></td>
      <td>${escapeHtml(delivery?.destination?.origin ?? '—')}<br /><span class="muted">${escapeHtml(delivery?.destination?.host ?? '—')}</span></td>
      <td>${escapeHtml(delivery.http_status ?? '—')}</td>
      <td>${escapeHtml(delivery.event_count ?? 0)}</td>
      <td>${escapeHtml(String(note).slice(0, 140))}</td>
      <td>${actionHtml}</td>
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

function parsePositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.trunc(parsed)));
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

function renderDeliveryPolicy(policy) {
  const summary = document.getElementById('deliveryPolicySummary');
  const mode = document.getElementById('deliveryPolicyMode');
  const status = document.getElementById('deliveryPolicyStatus');
  const textarea = document.getElementById('deliveryPolicyAllowedTargets');

  const source = policy?.source ?? 'deployment';
  const policyStatus = policy?.policy_status ?? 'inherited';
  const selectedMode = policy?.mode ?? 'inherit_remote_policy';
  const allowedTargets = Array.isArray(policy?.allowed_targets) ? policy.allowed_targets : [];

  summary.textContent = `source=${source}, status=${policyStatus}, mode=${selectedMode}, targets=${allowedTargets.length}`;
  if (status) {
    status.value = `${source} / ${policyStatus}`;
  }
  mode.value = selectedMode;
  textarea.value = allowedTargets.join('\n');
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
    document.getElementById('deliveryPolicySummary').textContent = 'admin gerekli';
    document.getElementById('securityDeliverySummary').textContent = 'admin gerekli';
    document.getElementById('securityDeliveryPreviewSummary').textContent = 'admin gerekli';
    document.getElementById('securitySigningSummary').textContent = 'admin gerekli';
    document.getElementById('securitySigningMetric').textContent = 'admin gerekli';
    renderUiSessionsTable([]);
    renderSecurityDeliveriesTable([]);
    renderSecuritySigningTable([]);
    log('Bu oturum admin yetkisine sahip değil; model policy, remote policy, delivery policy, security export signing, security delivery, session control ve MCP flush kontrolleri salt okunur moda alındı.');
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

async function loadDeliveryPolicy(settings) {
  await maybeRefreshSession(settings);

  const policy = await safeFetchJson(`${settings.baseUrl}/v1/security/export/delivery-policy`, {
    headers: authHeaders(settings)
  });

  renderDeliveryPolicy(policy);
  return policy;
}

async function saveDeliveryPolicy(settings) {
  await maybeRefreshSession(settings);

  const mode = document.getElementById('deliveryPolicyMode').value;
  const allowedTargets = parseAllowedModelsInput(document.getElementById('deliveryPolicyAllowedTargets').value);

  const policy = await safeFetchJson(`${settings.baseUrl}/v1/security/export/delivery-policy`, {
    method: 'PUT',
    headers: authHeaders(settings),
    body: JSON.stringify({ mode, allowedTargets })
  });

  renderDeliveryPolicy(policy);
  log(`Delivery egress policy güncellendi. mode=${policy.mode}, targets=${policy.allowed_targets?.length ?? 0}`);
  return policy;
}

async function resetDeliveryPolicy(settings) {
  await maybeRefreshSession(settings);

  const policy = await safeFetchJson(`${settings.baseUrl}/v1/security/export/delivery-policy`, {
    method: 'DELETE',
    headers: authHeaders(settings)
  });

  renderDeliveryPolicy(policy);
  log('Delivery egress policy deployment defaultlarına döndürüldü.');
  return policy;
}

async function previewSecurityDeliveryTarget(settings) {
  await maybeRefreshSession(settings);

  const destinationUrl = document.getElementById('securityDeliveryUrl').value.trim();
  if (!destinationUrl) {
    throw new Error('Önizleme için webhook / SIEM URL gerekli.');
  }

  const preview = await safeFetchJson(`${settings.baseUrl}/v1/security/export/deliveries/preview`, {
    method: 'POST',
    headers: authHeaders(settings),
    body: JSON.stringify({ destinationUrl })
  });

  const policy = preview?.policy ?? {};
  document.getElementById('securityDeliveryPreviewSummary').textContent = preview?.allowed
    ? `ALLOWED • mode=${policy.mode ?? 'unknown'} • matched=${preview?.matched_rule ?? '—'} • pinned=${preview?.pinned_address ?? '—'} • pathHash=${preview?.destination?.path_hash ?? '—'}`
    : `BLOCKED • mode=${policy.mode ?? 'unknown'} • reason=${preview?.reason ?? 'unknown'} • matched=${preview?.matched_rule ?? '—'} • pinned=${preview?.pinned_address ?? '—'}`;
  log(
    preview?.allowed
      ? `Delivery target preview ALLOWED. matched=${preview?.matched_rule ?? '—'}, pinned=${preview?.pinned_address ?? '—'}`
      : `Delivery target preview BLOCKED. reason=${preview?.reason ?? 'unknown'}, matched=${preview?.matched_rule ?? '—'}`
  );
  return preview;
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

async function downloadSecurityExport(settings) {
  await maybeRefreshSession(settings);

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const bundle = await safeFetchJson(
    `${settings.baseUrl}/v1/security/export?limit=500&since=${encodeURIComponent(since)}&top_ip_limit=5`,
    {
      headers: authHeaders(settings)
    }
  );

  const stamp = new Date().toISOString().replaceAll(':', '-');
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `smart-ai-security-export-${settings.tenantId}-${stamp}.json`;
  anchor.click();
  URL.revokeObjectURL(url);

  log(
    `Security export indirildi. events=${bundle?.data?.length ?? 0}, integrity=${bundle?.integrity?.verified ? 'ok' : 'broken'}`
  );
  return bundle;
}

async function loadSecuritySigningKeys(settings) {
  await maybeRefreshSession(settings);

  const response = await safeFetchJson(`${settings.baseUrl}/v1/security/export/keys`, {
    headers: authHeaders(settings)
  });

  const keys = Array.isArray(response?.data) ? response.data : [];
  const active = keys.find((key) => key.status === 'active');
  const lifecycle = response?.lifecycle ?? {};
  const policy = response?.policy ?? lifecycle.policy ?? {};
  document.getElementById('securitySigningMetric').textContent =
    active ? `active=${active.key_id.slice(0, 16)}…, verify=${Math.max(0, keys.length - 1)}` : 'key yok';
  document.getElementById('securitySigningHealthStatus').value = lifecycle.status ?? 'healthy';
  document.getElementById('securitySigningAutoRotate').value = String(policy.auto_rotate ?? true);
  document.getElementById('securitySigningRotateAfterHours').value = String(policy.rotate_after_hours ?? 720);
  document.getElementById('securitySigningExpireAfterHours').value = String(policy.expire_after_hours ?? 1080);
  document.getElementById('securitySigningWarnBeforeHours').value = String(policy.warn_before_hours ?? 168);
  document.getElementById('securitySigningVerifyRetentionHours').value = String(policy.verify_retention_hours ?? 2160);
  const alerts = Array.isArray(lifecycle.alerts) && lifecycle.alerts.length ? lifecycle.alerts.join(', ') : 'none';
  document.getElementById('securitySigningSummary').textContent =
    active
      ? `active=${active.key_id}, verify_only=${Math.max(0, keys.length - 1)}, status=${lifecycle.status ?? 'healthy'}, alerts=${alerts}, jwks=${response?.jwks_path ?? '/.well-known/smart-ai/security-export-keys.json'}`
      : 'Ed25519 signing key registry henüz bootstrap edilmedi.';
  renderSecuritySigningTable(keys);
  return response;
}

async function saveSecuritySigningPolicy(settings) {
  await maybeRefreshSession(settings);

  const payload = {
    auto_rotate: document.getElementById('securitySigningAutoRotate').value === 'true',
    rotate_after_hours: Number(document.getElementById('securitySigningRotateAfterHours').value),
    expire_after_hours: Number(document.getElementById('securitySigningExpireAfterHours').value),
    warn_before_hours: Number(document.getElementById('securitySigningWarnBeforeHours').value),
    verify_retention_hours: Number(document.getElementById('securitySigningVerifyRetentionHours').value)
  };

  const response = await safeFetchJson(`${settings.baseUrl}/v1/security/export/signing-policy`, {
    method: 'PUT',
    headers: {
      ...authHeaders(settings),
      origin: window.location.origin
    },
    body: JSON.stringify(payload)
  });

  const lifecycle = response?.lifecycle ?? {};
  log(`Security signing policy kaydedildi. status=${lifecycle.status ?? 'unknown'}, active=${lifecycle.active_key_id ?? 'unknown'}`);
  await loadSecuritySigningKeys(settings);
  return response;
}

async function rotateSecuritySigningKey(settings) {
  await maybeRefreshSession(settings);

  const response = await safeFetchJson(`${settings.baseUrl}/v1/security/export/keys/rotate`, {
    method: 'POST',
    headers: {
      ...authHeaders(settings),
      origin: window.location.origin
    },
    body: JSON.stringify({})
  });

  log(`Security export signing key rotate edildi. active=${response?.active_key_id ?? 'unknown'}`);
  await loadSecuritySigningKeys(settings);
  return response;
}

async function loadSecurityDeliveries(settings) {
  await maybeRefreshSession(settings);

  const response = await safeFetchJson(`${settings.baseUrl}/v1/security/export/deliveries?limit=10`, {
    headers: authHeaders(settings)
  });

  const deliveries = Array.isArray(response?.data) ? response.data : [];
  const queued = deliveries.filter((delivery) => delivery.status === 'queued' || delivery.status === 'retrying').length;
  const deadLetters = deliveries.filter((delivery) => delivery.status === 'dead_letter').length;
  const redriven = deliveries.filter((delivery) => Number(delivery.redrive_count ?? 0) > 0).length;
  document.getElementById('securityDeliverySummary').textContent =
    deliveries.length > 0
      ? `recent=${deliveries.length}, active=${queued}, dead-letter=${deadLetters}, redriven=${redriven}, last=${deliveries[0]?.status ?? '—'}, dedicated delivery-egress policy + HTTPS + host/path allowlist + Ed25519 signing + DNS pinning + encrypted retry queue + manual dead-letter redrive aktif`
      : 'Delivery egress dedicated policy plane ile yönetilir. Önce target preview yapın; ardından sync veya async (encrypted retry queue + backoff + dead-letter + manual redrive) delivery kullanın.';
  renderSecurityDeliveriesTable(deliveries);
  return deliveries;
}

async function redriveSecurityDelivery(settings, deliveryId) {
  await maybeRefreshSession(settings);

  const response = await safeFetchJson(`${settings.baseUrl}/v1/security/export/deliveries/${encodeURIComponent(deliveryId)}/redrive`, {
    method: 'POST',
    headers: {
      ...authHeaders(settings),
      origin: window.location.origin
    },
    body: JSON.stringify({})
  });

  const delivery = response?.data ?? {};
  log(
    `Security export dead-letter redrive kuyruğa alındı. source=${String(delivery.source_delivery_id ?? deliveryId).slice(0, 8)}…, status=${delivery.status ?? 'queued'}, redrive=${delivery.redrive_count ?? 0}, next=${delivery.next_attempt_at ?? 'hemen'}`
  );
  await loadSecurityDeliveries(settings);
  return delivery;
}

async function deliverSecurityExport(settings) {
  await maybeRefreshSession(settings);

  const destinationUrl = document.getElementById('securityDeliveryUrl').value.trim();
  if (!destinationUrl) {
    throw new Error('Webhook / SIEM URL gerekli.');
  }

  const mode = document.getElementById('securityDeliveryMode').value || 'sync';
  const windowHours = parsePositiveInteger(document.getElementById('securityDeliveryWindowHours').value, 24, {
    min: 1,
    max: 720
  });
  const limit = parsePositiveInteger(document.getElementById('securityDeliveryLimit').value, 500, {
    min: 1,
    max: 1000
  });

  const response = await safeFetchJson(`${settings.baseUrl}/v1/security/export/deliveries`, {
    method: 'POST',
    headers: {
      ...authHeaders(settings),
      origin: window.location.origin
    },
    body: JSON.stringify({
      destinationUrl,
      mode,
      windowHours,
      limit,
      topIpLimit: 5
    })
  });

  const delivery = response?.data ?? {};
  const queued = delivery.status === 'queued' || delivery.status === 'retrying';
  log(
    queued
      ? `Security export delivery kuyruğa alındı. status=${delivery.status ?? 'unknown'}, attempt=${delivery.attempt_count ?? 0}/${delivery.max_attempts ?? 1}, next=${delivery.next_attempt_at ?? 'hemen'}`
      : `Security export delivery tamamlandı. status=${delivery.status ?? 'unknown'}, http=${delivery.http_status ?? '—'}, events=${delivery.event_count ?? 0}`
  );
  await loadSecurityDeliveries(settings);
  return delivery;
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
  const securitySummary = await safeFetchJson(`${settings.baseUrl}/v1/security/summary?window_hours=24&top_ip_limit=5`, {
    headers: authHeaders(settings)
  });
  const security = await safeFetchJson(`${settings.baseUrl}/v1/security/events?limit=20&since=${encodeURIComponent(since)}`, {
    headers: authHeaders(settings)
  });
  const events = Array.isArray(security.data) ? security.data : [];
  document.getElementById('securityEvents').textContent =
    `risk=${securitySummary.riskLevel}, score=${securitySummary.riskScore}, ` +
    `events=${securitySummary.totalEvents}, integrity=${securitySummary?.integrity?.verified ? 'ok' : 'broken'}`;
  renderSecurityTable(events);

  await loadModelPolicy(settings);
  await loadRemotePolicy(settings);
  if (authContext?.permissions?.admin) {
    await loadDeliveryPolicy(settings);
    await loadSecuritySigningKeys(settings);
    await loadSecurityDeliveries(settings);
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
    document.getElementById('deliveryPolicySummary').textContent = '—';
    document.getElementById('securityDeliveryPreviewSummary').textContent = 'Önizleme yapılmadı.';
    document.getElementById('securityDeliverySummary').textContent = '—';
    document.getElementById('securitySigningSummary').textContent = '—';
    document.getElementById('securitySigningMetric').textContent = '—';
    renderUiSessionsTable([]);
    renderSecurityDeliveriesTable([]);
    renderSecuritySigningTable([]);
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
  document.getElementById('deliveryPolicySummary').textContent = '—';
  document.getElementById('securityDeliveryPreviewSummary').textContent = 'Önizleme yapılmadı.';
  document.getElementById('securityDeliverySummary').textContent = '—';
  document.getElementById('securitySigningSummary').textContent = '—';
  document.getElementById('securitySigningMetric').textContent = '—';
  renderUiSessionsTable([]);
  renderSecurityDeliveriesTable([]);
  renderSecuritySigningTable([]);

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

  document.getElementById('exportSecurity').addEventListener('click', async () => {
    const next = readSettingsForm();
    setSettings(next);

    try {
      await downloadSecurityExport(next);
      setStatus('Security export indirildi.');
    } catch (error) {
      setStatus(String(error), true);
      log(`Hata: ${String(error)}`);
    }
  });

  document.getElementById('previewSecurityDelivery').addEventListener('click', async () => {
    const next = readSettingsForm();
    setSettings(next);

    try {
      await previewSecurityDeliveryTarget(next);
      setStatus('Security export delivery hedefi önizlendi.');
    } catch (error) {
      setStatus(String(error), true);
      log(`Hata: ${String(error)}`);
    }
  });

  document.getElementById('deliverSecurityExport').addEventListener('click', async () => {
    const next = readSettingsForm();
    setSettings(next);

    try {
      await deliverSecurityExport(next);
      setStatus('Security export webhook delivery tamamlandı.');
    } catch (error) {
      setStatus(String(error), true);
      log(`Hata: ${String(error)}`);
    }
  });

  document.getElementById('securityDeliveryTableBody').addEventListener('click', async (event) => {
    const button = event.target?.closest?.('.redrive-delivery-btn');
    if (!button) {
      return;
    }

    const next = readSettingsForm();
    setSettings(next);
    const deliveryId = button.dataset.deliveryId;
    if (!deliveryId) {
      return;
    }

    if (!window.confirm('Bu dead-letter delivery tekrar kuyruğa alınsın mı? Hedef ve payload aynı kalır.')) {
      return;
    }

    button.disabled = true;
    try {
      await redriveSecurityDelivery(next, deliveryId);
      setStatus('Security export dead-letter redrive kuyruğa alındı.');
    } catch (error) {
      setStatus(String(error), true);
      log(`Hata: ${String(error)}`);
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById('saveSecuritySigningPolicy').addEventListener('click', async () => {
    const next = readSettingsForm();
    setSettings(next);

    try {
      await saveSecuritySigningPolicy(next);
      setStatus('Security export signing lifecycle policy kaydedildi.');
    } catch (error) {
      setStatus(String(error), true);
      log(`Hata: ${String(error)}`);
    }
  });

  document.getElementById('rotateSecuritySigningKey').addEventListener('click', async () => {
    const next = readSettingsForm();
    setSettings(next);

    if (!window.confirm('Aktif security export signing key rotate edilsin mi? Yeni key signing için aktif olacak, önceki key verify-only kalacak.')) {
      return;
    }

    try {
      await rotateSecuritySigningKey(next);
      setStatus('Security export signing key rotate edildi.');
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

  document.getElementById('saveDeliveryPolicy').addEventListener('click', async () => {
    const next = readSettingsForm();
    setSettings(next);

    try {
      await saveDeliveryPolicy(next);
      setStatus('Delivery egress policy kaydedildi.');
    } catch (error) {
      setStatus(String(error), true);
      log(`Hata: ${String(error)}`);
    }
  });

  document.getElementById('resetDeliveryPolicy').addEventListener('click', async () => {
    const next = readSettingsForm();
    setSettings(next);

    try {
      await resetDeliveryPolicy(next);
      setStatus('Delivery egress policy deployment defaultlarına döndü.');
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
    document.getElementById('deliveryPolicySummary').textContent = '—';
    document.getElementById('securityDeliveryPreviewSummary').textContent = 'Önizleme yapılmadı.';
    document.getElementById('securitySigningSummary').textContent = '—';
    document.getElementById('securitySigningMetric').textContent = '—';
    renderSecuritySigningTable([]);
  }
}

void init();
