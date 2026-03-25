const SETTINGS_STORAGE_KEY = 'smart_ai_ui_settings_v2';
const SESSION_STORAGE_KEY = 'smart_ai_ui_session_token_v1';
const SESSION_META_STORAGE_KEY = 'smart_ai_ui_session_meta_v1';

function defaultSettings() {
  return {
    baseUrl: window.location.origin,
    tenantId: 'tenant-a',
    model: ''
  };
}

function getSettings() {
  const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (!raw) return defaultSettings();

  try {
    return { ...defaultSettings(), ...JSON.parse(raw) };
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

function applyUiPermissions({ canRead = false, canOperate = false } = {}) {
  for (const id of ['modelSelect', 'loadModels']) {
    const node = document.getElementById(id);
    if (node) {
      node.disabled = !canRead;
    }
  }

  for (const id of ['chatInput']) {
    const node = document.getElementById(id);
    if (node) {
      node.disabled = !canOperate;
    }
  }

  const submitButton = document.querySelector('#chatForm button[type="submit"]');
  if (submitButton) {
    submitButton.disabled = !canOperate;
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

function renderMessage(role, content) {
  const box = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = `<strong>${role === 'user' ? 'Sen' : role === 'assistant' ? 'SMART-AI' : 'Sistem'}:</strong><br>${String(content).replace(/</g, '&lt;')}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function setStatus(message, isError = false) {
  const node = document.getElementById('settingsStatus');
  node.textContent = message;
  node.style.color = isError ? 'var(--danger)' : 'var(--muted)';
}

async function fetchJson(url, options = {}) {
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

  const refreshed = await fetchJson(`${settings.baseUrl}/ui/session/refresh`, {
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
    lastSeenAt: refreshed?.lastSeenAt,
    principalName: refreshed?.principalName,
    scopes: refreshed?.scopes
  });
}

function fillSettingsForm(settings) {
  document.getElementById('baseUrl').value = settings.baseUrl;
  document.getElementById('tenantId').value = settings.tenantId;
}

function readSettingsForm() {
  return {
    baseUrl: document.getElementById('baseUrl').value.trim().replace(/\/$/, ''),
    tenantId: document.getElementById('tenantId').value.trim(),
    model: document.getElementById('modelSelect').value || ''
  };
}

function applyAuthContext(context) {
  const permissions = context?.permissions ?? {};
  const scopes = Array.isArray(context?.scopes) ? context.scopes.join(', ') : '—';
  const principalName = context?.principal_name ?? 'unknown';
  const canOperate = Boolean(permissions.operate);

  applyUiPermissions({
    canRead: Boolean(permissions.read),
    canOperate
  });
  setSessionCapabilities(
    `Yetki bilgisi: ${principalName} | scopes=${scopes} | operate=${canOperate ? 'evet' : 'hayır'}`,
    false
  );

  if (!canOperate) {
    renderMessage('system', 'Bu oturum sohbet/işlem gönderme yetkisine sahip değil. Operate scope içeren bir anahtar kullanın.');
  }
}

async function loadAuthContext(settings) {
  await maybeRefreshSession(settings);

  const context = await fetchJson(`${settings.baseUrl}/v1/auth/context`, {
    headers: authHeaders(settings)
  });

  applyAuthContext(context);
  return context;
}

async function signIn(settings) {
  const apiKey = document.getElementById('apiKey').value.trim();
  if (!apiKey) {
    throw new Error('API Key gerekli.');
  }

  const data = await fetchJson(`${settings.baseUrl}/ui/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey, tenantId: settings.tenantId })
  });

  setSessionToken(data?.token ?? '');
  setSessionMeta({
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
  setStatus(`Oturum açıldı. Token bitiş: ${data.expiresAt}`);
}

async function signOut(settings) {
  const token = getSessionToken();
  if (!token) {
    setStatus('Aktif oturum yok.');
    return;
  }

  try {
    await fetchJson(`${settings.baseUrl}/ui/session/revoke`, {
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
    applyUiPermissions({ canRead: false, canOperate: false });
    setSessionCapabilities('Yetki bilgisi: aktif oturum yok.');
  }

  setStatus('Oturum kapatıldı.');
}

async function loadModels(settings) {
  await maybeRefreshSession(settings);

  const data = await fetchJson(`${settings.baseUrl}/v1/models`, {
    headers: authHeaders(settings)
  });

  const select = document.getElementById('modelSelect');
  select.innerHTML = '';

  const models = Array.isArray(data.data) ? data.data : [];
  for (const item of models) {
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = item.is_default ? `${item.id} (default)` : item.id;
    select.appendChild(opt);
  }

  if (settings.model) {
    select.value = settings.model;
  }

  if (!select.value && data?.meta?.default_model) {
    select.value = data.meta.default_model;
  }

  if (!select.value && models[0]?.id) {
    select.value = models[0].id;
  }

  if (data?.meta?.default_model) {
    setStatus(`Model listesi yüklendi. Default: ${data.meta.default_model}`);
  }
}

async function sendMessage(settings, message) {
  renderMessage('user', message);
  await maybeRefreshSession(settings);

  const payload = {
    ...(settings.model ? { model: settings.model } : {}),
    messages: [{ role: 'user', content: message }],
    stream: false
  };

  const data = await fetchJson(`${settings.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: authHeaders(settings),
    body: JSON.stringify(payload)
  });

  const content = data?.choices?.[0]?.message?.content ?? 'Yanıt alınamadı.';
  renderMessage('assistant', content);
}

async function init() {
  const settings = getSettings();
  fillSettingsForm(settings);
  applyUiPermissions({ canRead: false, canOperate: false });
  setSessionCapabilities('Yetki bilgisi: aktif oturum yok.');

  document.getElementById('saveSettings').addEventListener('click', () => {
    const next = readSettingsForm();
    setSettings(next);
    setStatus('Ayarlar kaydedildi. API Key saklanmaz.');
  });

  document.getElementById('signIn').addEventListener('click', async () => {
    const next = readSettingsForm();
    setSettings(next);

    try {
      await signIn(next);
      const context = await loadAuthContext(next);
      if (context?.permissions?.read) {
        await loadModels(next);
      }
      setStatus('Oturum hazır, model listesi yüklendi.');
    } catch (error) {
      setStatus(String(error), true);
      renderMessage('system', String(error));
    }
  });

  document.getElementById('signOut').addEventListener('click', async () => {
    const next = readSettingsForm();
    setSettings(next);

    try {
      await signOut(next);
    } catch (error) {
      setStatus(String(error), true);
      renderMessage('system', String(error));
    }
  });

  document.getElementById('loadModels').addEventListener('click', async () => {
    const next = readSettingsForm();
    setSettings(next);

    try {
      await loadModels(next);
      setStatus('Model listesi yüklendi.');
    } catch (error) {
      setStatus(String(error), true);
      renderMessage('system', String(error));
    }
  });

  document.getElementById('chatForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = document.getElementById('chatInput');
    const message = input.value.trim();
    if (!message) return;

    input.value = '';

    const next = readSettingsForm();
    setSettings(next);

    try {
      setStatus('Mesaj gönderiliyor...');
      await sendMessage(next, message);
      setStatus('Yanıt alındı.');
    } catch (error) {
      setStatus(String(error), true);
      renderMessage('system', String(error));
    }
  });

  document.getElementById('clearChat').addEventListener('click', () => {
    const box = document.getElementById('chatMessages');
    box.innerHTML = '';
  });

  if (!getSessionToken()) {
    setStatus('Önce API Key ile oturum açın.', false);
    renderMessage('system', 'Güvenlik için API Key localStorage yerine kısa ömürlü oturum tokenına çevrilir.');
    return;
  }

  try {
    const context = await loadAuthContext(settings);
    if (context?.permissions?.read) {
      await loadModels(settings);
    }
    setStatus('Chat UI hazır.');
  } catch {
    setStatus('Oturum süresi dolmuş olabilir. Tekrar giriş yapın.', false);
    setSessionToken('');
    setSessionMeta(null);
    applyUiPermissions({ canRead: false, canOperate: false });
    setSessionCapabilities('Yetki bilgisi: aktif oturum yok.');
  }
}

void init();
