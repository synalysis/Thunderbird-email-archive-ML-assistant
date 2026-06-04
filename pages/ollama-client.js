function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/$/, '');
}

function hostPermissionPattern(baseUrl) {
  const parsed = new URL(baseUrl);
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  return `${parsed.protocol}//${parsed.hostname}:${port}/*`;
}

function isEmbedModelName(name) {
  return /embed|bge-|gte-|minilm/i.test(name);
}

const OLLAMA_CORS_HELP =
  'Ollama blocked this request (CORS). Restart Ollama with:\n' +
  '  OLLAMA_ORIGINS="moz-extension://*" ollama serve\n' +
  'On Linux with systemd: sudo systemctl edit ollama → add\n' +
  '  Environment="OLLAMA_ORIGINS=moz-extension://*"\n' +
  'then: sudo systemctl daemon-reload && sudo systemctl restart ollama';

async function ollamaTagsResponse(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  const response = await fetch(`${normalized}/api/tags`);
  if (response.status === 403) {
    throw new Error(OLLAMA_CORS_HELP);
  }
  if (!response.ok) {
    throw new Error(`Ollama returned HTTP ${response.status} at ${normalized}`);
  }
  return response.json();
}

async function ensureHostPermission(baseUrl) {
  const pattern = hostPermissionPattern(baseUrl);
  if (await browser.permissions.contains({ origins: [pattern] })) {
    return true;
  }
  return browser.permissions.request({ origins: [pattern] });
}

async function fetchOllamaTags(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  const granted = await ensureHostPermission(normalized);
  if (!granted) {
    throw new Error(
      'Permission denied. Click Test connection and approve access to ' + normalized
    );
  }
  let data;
  try {
    data = await ollamaTagsResponse(normalized);
  } catch (error) {
    if (error.message === OLLAMA_CORS_HELP) {
      throw error;
    }
    throw new Error(
      'Cannot connect to Ollama at ' + normalized + '.\n' +
      '• Run: OLLAMA_ORIGINS="moz-extension://*" ollama serve\n' +
      '• Or use ./scripts/ollama-serve-thunderbird.sh from this project\n' +
      '• Click Test connection and approve the permission prompt'
    );
  }
  const all = (data.models || []).map(m => m.name).sort();
  const embedModels = all.filter(isEmbedModelName);
  const chatModels = all.filter(name => !isEmbedModelName(name));
  return {
    baseUrl: normalized,
    all,
    chatModels: chatModels.length ? chatModels : all,
    embedModels: embedModels.length ? embedModels : all
  };
}
