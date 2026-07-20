function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/$/, '');
}

function hostPermissionPattern(baseUrl) {
  const parsed = new URL(baseUrl);
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  return `${parsed.protocol}//${parsed.hostname}:${port}/*`;
}

function isEmbedModelName(name) {
  return /embed|bge-|gte-|minilm|e5-|nomic|m3/i.test(name);
}

const LLAMA_CONNECT_HELP =
  'Cannot connect to llama.cpp embedding server.\n' +
  '• Start llama-server on port 8083, e.g.:\n' +
  '  llama-server -m embed-model.gguf --embedding --pooling cls --port 8083\n' +
  '• Click Test connection and approve the permission prompt';

function permissionDeniedMessage(baseUrl) {
  return (
    'Host permission required for ' + baseUrl + '. ' +
    'Click Test connection on the Training tab and approve the prompt.'
  );
}

async function hasHostPermission(baseUrl) {
  const pattern = hostPermissionPattern(baseUrl);
  try {
    return await browser.permissions.contains({ origins: [pattern] });
  } catch (_) {
    return false;
  }
}

function requestHostPermission(baseUrl) {
  const pattern = hostPermissionPattern(baseUrl);
  return browser.permissions.request({ origins: [pattern] });
}

async function llamaHealthResponse(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  const response = await fetch(`${normalized}/health`, {
    headers: { Authorization: 'Bearer no-key' }
  });
  if (!response.ok) {
    throw new Error(`llama.cpp server returned HTTP ${response.status} at ${normalized}`);
  }
  return normalized;
}

async function llamaModelsResponse(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  const response = await fetch(`${normalized}/v1/models`, {
    headers: { Authorization: 'Bearer no-key' }
  });
  if (!response.ok) {
    return [];
  }
  const data = await response.json();
  return (data.data || []).map(m => m.id).filter(Boolean);
}

async function probeEmbeddingsClient(baseUrl, model) {
  const normalized = normalizeBaseUrl(baseUrl);
  const response = await fetch(`${normalized}/v1/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer no-key',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: model || 'default',
      input: 'connection test',
      encoding_format: 'float'
    })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Embeddings failed (HTTP ${response.status}): ${text.slice(0, 160)}`);
  }
  const data = await response.json();
  const dims = data.data?.[0]?.embedding?.length || 0;
  if (!dims) {
    throw new Error('Embeddings endpoint returned no vector');
  }
  return dims;
}

async function fetchLlamaTags(embedBaseUrl) {
  const embed = normalizeBaseUrl(embedBaseUrl);
  if (!(await hasHostPermission(embed))) {
    throw new Error(permissionDeniedMessage(embed));
  }
  try {
    await llamaHealthResponse(embed);
  } catch (error) {
    throw new Error(`${LLAMA_CONNECT_HELP}\n(${embed})`);
  }

  let embedModels = await llamaModelsResponse(embed);
  embedModels = [...new Set(embedModels)].sort();
  if (!embedModels.length) {
    embedModels = ['default'];
  }
  const embedNamed = embedModels.filter(isEmbedModelName);
  const embedPicker = embedNamed.length ? embedNamed : embedModels;

  const embeddingDims = await probeEmbeddingsClient(
    embed,
    embedPicker[0]
  );

  return {
    embedBaseUrl: embed,
    embedModels: embedPicker,
    embeddingDims
  };
}
