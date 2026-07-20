/* global browser */

const DEFAULT_LLAMA_SETTINGS = {
  embedBaseUrl: 'http://127.0.0.1:8083',
  embedModel: '',
  maxSamplesPerFolder: 10,
  maxTotalIndexEntries: 0,
  bodyPreviewLength: 1200
};

const DEFAULT_MODEL_ID = 'default';

// llama-server default physical batch is 512 tokens. Cap below that: addresses
// tokenize denser than plain text (~2.2 chars/token observed with To/Cc headers).
const LLAMA_SERVER_BATCH_TOKENS = 512;
const EMBED_TOKEN_HEADROOM = 48;
const EMBED_TARGET_TOKENS = LLAMA_SERVER_BATCH_TOKENS - EMBED_TOKEN_HEADROOM;
const EMBED_CHARS_PER_TOKEN = 2.0;
const EMBED_MAX_INPUT_CHARS = Math.floor(EMBED_TARGET_TOKENS * EMBED_CHARS_PER_TOKEN);

const EMBED_AVAILABLE_TTL_MS = 120000;
let embedAvailableUntil = 0;
let embedAvailableKey = '';
let cachedEmbedModel = null;
let cachedEmbedModelKey = '';
const messageEmbeddingCache = new Map();
const MESSAGE_EMBED_CACHE_MAX = 48;

function clearLlamaRuntimeCaches() {
  embedAvailableUntil = 0;
  embedAvailableKey = '';
  cachedEmbedModel = null;
  cachedEmbedModelKey = '';
  messageEmbeddingCache.clear();
}

function touchMessageEmbeddingCache(messageId, entry) {
  if (messageEmbeddingCache.has(messageId)) {
    messageEmbeddingCache.delete(messageId);
  }
  messageEmbeddingCache.set(messageId, entry);
  while (messageEmbeddingCache.size > MESSAGE_EMBED_CACHE_MAX) {
    const oldest = messageEmbeddingCache.keys().next().value;
    messageEmbeddingCache.delete(oldest);
  }
}

function getMessageEmbeddingCache(messageId) {
  return messageEmbeddingCache.get(messageId) || null;
}

function normalizeLlamaSettings(raw) {
  const merged = { ...DEFAULT_LLAMA_SETTINGS, ...(raw || {}) };
  if (merged.baseUrl?.includes(':11434')) {
    merged.baseUrl = '';
  }
  if (!merged.embedBaseUrl && merged.baseUrl) {
    merged.embedBaseUrl = merged.baseUrl;
  }
  merged.embedBaseUrl = String(
    merged.embedBaseUrl || DEFAULT_LLAMA_SETTINGS.embedBaseUrl
  ).replace(/\/$/, '');
  merged.baseUrl = merged.embedBaseUrl;
  delete merged.chatBaseUrl;
  delete merged.chatModel;
  delete merged.ragTopK;

  let perFolder = parseInt(merged.maxSamplesPerFolder, 10);
  if (!Number.isFinite(perFolder) || perFolder < 1) {
    perFolder = DEFAULT_LLAMA_SETTINGS.maxSamplesPerFolder;
  }
  if (perFolder > 100) {
    perFolder = 100;
  }
  merged.maxSamplesPerFolder = perFolder;

  let totalCap = parseInt(merged.maxTotalIndexEntries, 10);
  if (!Number.isFinite(totalCap) || totalCap < 0) {
    totalCap = 0;
  }
  merged.maxTotalIndexEntries = totalCap;

  let previewLen = parseInt(merged.bodyPreviewLength, 10);
  if (!Number.isFinite(previewLen) || previewLen < 200) {
    previewLen = DEFAULT_LLAMA_SETTINGS.bodyPreviewLength;
  }
  if (previewLen > 1200) {
    previewLen = 1200;
  }
  merged.bodyPreviewLength = previewLen;
  return merged;
}

async function migrateStoredSettings() {
  const stored = await browser.storage.local.get(['llamaSettings', 'ollamaSettings']);
  if (stored.llamaSettings) {
    return stored.llamaSettings;
  }
  if (stored.ollamaSettings) {
    const migrated = normalizeLlamaSettings(stored.ollamaSettings);
    await browser.storage.local.set({ llamaSettings: migrated });
    return migrated;
  }
  return null;
}

async function getLlamaSettings() {
  const raw = await migrateStoredSettings();
  return normalizeLlamaSettings(raw);
}

async function saveLlamaSettings(partial) {
  const next = normalizeLlamaSettings({
    ...(await getLlamaSettings()),
    ...partial
  });
  if (partial?.embedBaseUrl) {
    next.baseUrl = next.embedBaseUrl;
  }
  if (partial?.embedBaseUrl || partial?.embedModel) {
    clearLlamaRuntimeCaches();
  }
  await browser.storage.local.set({ llamaSettings: next });
  return next;
}

function hostPermissionPattern(baseUrl) {
  const parsed = new URL(baseUrl);
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  return `${parsed.protocol}//${parsed.hostname}:${port}/*`;
}

async function hasHostPermission(baseUrl) {
  try {
    return await browser.permissions.contains({
      origins: [hostPermissionPattern(baseUrl)]
    });
  } catch (_) {
    return false;
  }
}

function embedBaseUrl(settings) {
  return (settings.embedBaseUrl || settings.baseUrl || DEFAULT_LLAMA_SETTINGS.embedBaseUrl)
    .replace(/\/$/, '');
}

const LLAMA_CONNECT_HELP =
  'Cannot reach llama.cpp embedding server.\n' +
  '• Start llama-server on port 8083, e.g.:\n' +
  '  llama-server -m embed-model.gguf --embedding --pooling cls --port 8083 --host 127.0.0.1';

async function llamaFetch(url, options = {}, settings) {
  const base = embedBaseUrl(settings || { embedBaseUrl: url });
  const headers = {
    Authorization: 'Bearer no-key',
    ...(options.headers || {})
  };
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  try {
    return await fetch(url, { ...options, headers });
  } catch (error) {
    throw new Error(`${LLAMA_CONNECT_HELP}\n(${base})`);
  }
}

async function checkServerHealth(baseUrl, settings) {
  const response = await llamaFetch(`${baseUrl}/health`, { method: 'GET' }, settings);
  if (!response.ok) {
    throw new Error(`${LLAMA_CONNECT_HELP}\n(${baseUrl} returned HTTP ${response.status})`);
  }
}

async function listModelsAt(baseUrl, settings) {
  const response = await llamaFetch(`${baseUrl}/v1/models`, { method: 'GET' }, settings);
  if (!response.ok) {
    return [];
  }
  const data = await response.json();
  return (data.data || []).map(m => m.id).filter(Boolean).sort();
}

async function listLlamaModels(settings) {
  const embedBase = embedBaseUrl(settings);
  await checkServerHealth(embedBase, settings);
  const embedModels = await listModelsAt(embedBase, settings);
  if (embedModels.length) {
    return embedModels;
  }
  return settings.embedModel ? [settings.embedModel] : [DEFAULT_MODEL_ID];
}

function isEmbedModelName(name) {
  return /embed|bge-|gte-|minilm|e5-|nomic|m3/i.test(name);
}

async function resolveEmbedModel(settings) {
  const key = `${embedBaseUrl(settings)}|${settings.embedModel || ''}`;
  if (cachedEmbedModel && cachedEmbedModelKey === key) {
    return cachedEmbedModel;
  }
  let model;
  if (settings.embedModel) {
    model = settings.embedModel;
  } else {
    const models = await listLlamaModels(settings);
    const embedNamed = models.find(isEmbedModelName);
    model = embedNamed || models[0] || DEFAULT_MODEL_ID;
  }
  cachedEmbedModel = model;
  cachedEmbedModelKey = key;
  return model;
}

async function probeEmbeddings(settings, model) {
  const base = embedBaseUrl(settings);
  const data = await llamaRequest(`${base}/v1/embeddings`, {
    model: model || DEFAULT_MODEL_ID,
    input: 'connection test',
    encoding_format: 'float'
  }, settings);
  const embedding = data.data?.[0]?.embedding;
  if (!embedding?.length) {
    throw new Error('Embeddings endpoint returned no vector');
  }
  return embedding.length;
}

async function checkLlamaEmbedAvailable(settings) {
  const key = `${embedBaseUrl(settings)}|${settings.embedModel || ''}`;
  if (Date.now() < embedAvailableUntil && embedAvailableKey === key) {
    return;
  }
  const embedBase = embedBaseUrl(settings);
  await checkServerHealth(embedBase, settings);
  const model = await resolveEmbedModel(settings);
  await probeEmbeddings(settings, model);
  embedAvailableKey = key;
  embedAvailableUntil = Date.now() + EMBED_AVAILABLE_TTL_MS;
}

async function llamaRequest(url, body, settings) {
  const response = await llamaFetch(url, {
    method: 'POST',
    body: JSON.stringify(body)
  }, settings);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`llama.cpp error (${response.status}): ${text.slice(0, 240)}`);
  }
  return response.json();
}

function truncateText(text, maxLen) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…`;
}

function extractPlainBody(part) {
  if (!part) return '';
  const ctype = (part.contentType || part.type || '').toLowerCase();
  if (part.body && ctype.includes('text/plain')) {
    return part.body;
  }
  if (part.body && ctype.includes('text/html')) {
    return part.body.replace(/<[^>]+>/g, ' ');
  }
  if (part.body && !part.parts) {
    return part.body;
  }
  if (part.parts) {
    for (const child of part.parts) {
      const childType = (child.contentType || child.type || '').toLowerCase();
      if (childType.includes('text/plain')) {
        const text = extractPlainBody(child);
        if (text) return text;
      }
    }
    for (const child of part.parts) {
      const text = extractPlainBody(child);
      if (text) return text;
    }
  }
  return part.body || '';
}

function formatHeaderAddresses(value) {
  if (!value) {
    return '';
  }
  if (Array.isArray(value)) {
    return value.map(item => String(item).trim()).filter(Boolean).join(', ');
  }
  return String(value).trim();
}

function headerField(headers, name) {
  if (!headers) {
    return '';
  }
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  return formatHeaderAddresses(value);
}

function extractRecipients(headers) {
  const to = headerField(headers, 'To');
  const cc = headerField(headers, 'Cc');
  const parts = [];
  if (to) {
    parts.push(to);
  }
  if (cc) {
    parts.push(`Cc: ${cc}`);
  }
  return parts.join('\n');
}

async function getMessageContent(messageId, previewLength) {
  const full = await browser.messages.getFull(messageId);
  const headers = full.headers || {};
  const header = headerField(headers, 'From') || full.author || '';
  const subject = headerField(headers, 'Subject') || full.subject || '';
  const recipients = extractRecipients(headers);
  const body = truncateText(extractPlainBody(full), previewLength);
  return {
    author: header,
    recipients,
    subject,
    bodyPreview: body
  };
}

function capEmbedInput(text) {
  return truncateText(String(text || '').trim(), EMBED_MAX_INPUT_CHARS);
}

function buildEmbedText(entry) {
  const lines = [];
  const author = String(entry.author || '').trim();
  const recipients = String(entry.recipients || '').trim();
  const subject = String(entry.subject || '').trim();
  if (author) {
    lines.push(author);
  }
  if (recipients) {
    lines.push(`To: ${recipients}`);
  }
  if (subject) {
    lines.push(subject);
  }
  const headerBlock = lines.join('\n');
  const separator = headerBlock && entry.bodyPreview ? 1 : 0;
  const bodyBudget = Math.max(0, EMBED_MAX_INPUT_CHARS - headerBlock.length - separator);
  const body = truncateText(entry.bodyPreview || '', bodyBudget);
  const parts = [];
  if (headerBlock) {
    parts.push(headerBlock);
  }
  if (body) {
    parts.push(body);
  }
  return capEmbedInput(parts.join('\n'));
}

async function embedText(text, settings) {
  const base = embedBaseUrl(settings);
  const model = await resolveEmbedModel(settings);
  const input = capEmbedInput(text);
  const data = await llamaRequest(`${base}/v1/embeddings`, {
    model,
    input,
    encoding_format: 'float'
  }, settings);
  const embedding = data.data?.[0]?.embedding;
  if (!embedding || !Array.isArray(embedding)) {
    throw new Error('Invalid embedding response from llama.cpp server');
  }
  return embedding;
}

function cosineSimilarity(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function uniqueFolders(entries) {
  return [...new Set(entries.map(e => e.folderPath))].sort();
}

function scoreFoldersBySimilarity(index, queryEmbedding, folderPaths) {
  const bestScore = new Map(folderPaths.map(path => [path, 0]));
  for (const entry of index.entries) {
    if (!entry.folderPath || !entry.embedding?.length) {
      continue;
    }
    if (!bestScore.has(entry.folderPath)) {
      continue;
    }
    const score = cosineSimilarity(queryEmbedding, entry.embedding);
    if (score > bestScore.get(entry.folderPath)) {
      bestScore.set(entry.folderPath, score);
    }
  }
  return folderPaths
    .map(path => ({ path, score: bestScore.get(path) || 0 }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      const nameA = (a.path.split('/').pop() || a.path).toLowerCase();
      const nameB = (b.path.split('/').pop() || b.path).toLowerCase();
      return nameA.localeCompare(nameB);
    });
}

async function getMessageEmbedding(messageId, settings) {
  const cached = getMessageEmbeddingCache(messageId);
  if (cached) {
    return cached;
  }
  const content = await getMessageContent(messageId, settings.bodyPreviewLength);
  const queryText = buildEmbedText({
    author: content.author,
    recipients: content.recipients,
    subject: content.subject,
    bodyPreview: content.bodyPreview
  });
  const embedding = await embedText(queryText, settings);
  const entry = { content, queryText, embedding };
  touchMessageEmbeddingCache(messageId, entry);
  return entry;
}

async function rankFoldersForMessage(index, messageId, folderPaths, settings) {
  if (
    index.settings?.embedModel &&
    settings.embedModel &&
    index.settings.embedModel !== settings.embedModel
  ) {
    throw new Error(
      `Index was built with “${index.settings.embedModel}”, but settings use “${settings.embedModel}”. ` +
      'Rebuild the index on the Training tab.'
    );
  }
  const { embedding } = await getMessageEmbedding(messageId, settings);
  return scoreFoldersBySimilarity(index, embedding, folderPaths);
}

async function classifyMessageRagOnly(index, messageId, settings) {
  const folders = uniqueFolders(index.entries);
  if (folders.length === 0) {
    throw new Error('Index has no folders');
  }
  const { embedding } = await getMessageEmbedding(messageId, settings);
  const ranked = scoreFoldersBySimilarity(index, embedding, folders);
  const top = ranked[0];
  if (!top?.path || top.score <= 0) {
    return { folder: null, confidence: 0 };
  }
  return {
    folder: top.path,
    confidence: Math.round(Math.min(1, top.score) * 1000) / 10
  };
}

async function embedBatch(texts, settings, onProgress) {
  const embeddings = [];
  for (let i = 0; i < texts.length; i++) {
    embeddings.push(await embedText(texts[i], settings));
    if (onProgress) onProgress(i + 1, texts.length);
  }
  return embeddings;
}

async function testLlamaConnection(settings) {
  const embedBase = embedBaseUrl(settings);
  await checkServerHealth(embedBase, settings);
  const models = await listLlamaModels(settings);
  const model = await resolveEmbedModel(settings);
  const embeddingDims = await probeEmbeddings(settings, model);
  return {
    ok: true,
    modelCount: models.length,
    models,
    baseUrl: embedBase,
    embedModel: model,
    embeddingDims
  };
}

window.llamaArchive = {
  DEFAULT_LLAMA_SETTINGS,
  getLlamaSettings,
  saveLlamaSettings,
  hostPermissionPattern,
  hasHostPermission,
  listLlamaModels,
  testLlamaConnection,
  isEmbedModelName,
  checkLlamaEmbedAvailable,
  clearLlamaRuntimeCaches,
  getMessageEmbedding,
  getMessageEmbeddingCache,
  getMessageContent,
  buildEmbedText,
  embedText,
  embedBatch,
  classifyMessageRagOnly,
  rankFoldersForMessage,
  truncateText
};
