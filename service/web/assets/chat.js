const STORAGE_KEY = 'smart_ai_ui_settings_v1';

function defaultSettings() {
  return {
    baseUrl: window.location.origin,
    apiKey: '',
    tenantId: 'tenant-a',
    model: 'openrouter/agentic-default'
  };
}

function getSettings() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return defaultSettings();

  try {
    return { ...defaultSettings(), ...JSON.parse(raw) };
  } catch {
    return defaultSettings();
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

function fillSettingsForm(settings) {
  document.getElementById('baseUrl').value = settings.baseUrl;
  document.getElementById('apiKey').value = settings.apiKey;
  document.getElementById('tenantId').value = settings.tenantId;
}

function readSettingsForm() {
  return {
    baseUrl: document.getElementById('baseUrl').value.trim().replace(/\/$/, ''),
    apiKey: document.getElementById('apiKey').value.trim(),
    tenantId: document.getElementById('tenantId').value.trim(),
    model: document.getElementById('modelSelect').value || 'openrouter/agentic-default'
  };
}

async function loadModels(settings) {
  const data = await fetchJson(`${settings.baseUrl}/v1/models`, {
    headers: authHeaders(settings)
  });

  const select = document.getElementById('modelSelect');
  select.innerHTML = '';

  const models = Array.isArray(data.data) ? data.data : [];
  for (const item of models) {
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = item.id;
    select.appendChild(opt);
  }

  if (settings.model) {
    select.value = settings.model;
  }

  if (!select.value && models[0]?.id) {
    select.value = models[0].id;
  }
}

async function sendMessage(settings, message) {
  renderMessage('user', message);

  const payload = {
    model: settings.model || 'openrouter/agentic-default',
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

  document.getElementById('saveSettings').addEventListener('click', () => {
    const next = readSettingsForm();
    setSettings(next);
    setStatus('Ayarlar kaydedildi.');
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

  try {
    await loadModels(settings);
    setStatus('Chat UI hazır.');
  } catch (error) {
    setStatus('Model yükleme için API Key/Tenant girin.', false);
    renderMessage('system', 'Model yükleme için önce API Key ve Tenant girin.');
  }
}

void init();
