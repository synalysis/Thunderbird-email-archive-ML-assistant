/* global browser */

const DEFAULT_OLLAMA_SETTINGS = {
  baseUrl: 'http://127.0.0.1:11434',
  chatModel: 'qwen2.5:3b-instruct',
  embedModel: 'nomic-embed-text',
  maxSamplesPerFolder: 10,
  maxTotalIndexEntries: 0,
  bodyPreviewLength: 1200,
  ragTopK: 5
};

const RAG_TOP_K_DEFAULT = 5;

function normalizeOllamaSettings(raw) {
  const merged = { ...DEFAULT_OLLAMA_SETTINGS, ...(raw || {}) };
  let perFolder = parseInt(merged.maxSamplesPerFolder, 10);
  if (!Number.isFinite(perFolder) || perFolder < 1) {
    perFolder = DEFAULT_OLLAMA_SETTINGS.maxSamplesPerFolder;
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
  return merged;
}

async function getOllamaSettings() {
  const stored = await browser.storage.local.get('ollamaSettings');
  return normalizeOllamaSettings(stored.ollamaSettings);
}

async function saveOllamaSettings(partial) {
  const next = normalizeOllamaSettings({
    ...(await getOllamaSettings()),
    ...partial
  });
  await browser.storage.local.set({ ollamaSettings: next });
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

const OLLAMA_CORS_HELP =
  'Ollama blocked this request (CORS). Restart Ollama with:\n' +
  '  OLLAMA_ORIGINS="moz-extension://*" ollama serve';

async function ollamaFetch(url, options, settings) {
  const base = (settings?.baseUrl || url).replace(/\/$/, '').replace(/\/api\/.*$/, '');
  try {
    const response = await fetch(url, options);
    if (response.status === 403) {
      throw new Error(OLLAMA_CORS_HELP);
    }
    return response;
  } catch (error) {
    if (error.message === OLLAMA_CORS_HELP) {
      throw error;
    }
    throw new Error(
      'Cannot connect to Ollama at ' + base + '.\n' +
      '• Run: OLLAMA_ORIGINS="moz-extension://*" ollama serve'
    );
  }
}

async function listOllamaModels(settings) {
  const base = settings.baseUrl.replace(/\/$/, '');
  const response = await ollamaFetch(`${base}/api/tags`, undefined, settings);
  if (!response.ok) {
    throw new Error('Cannot reach Ollama. Start it with: ollama serve');
  }
  const data = await response.json();
  return (data.models || []).map(m => m.name).sort();
}

function isEmbedModelName(name) {
  return /embed|bge-|gte-|minilm/i.test(name);
}

async function ollamaRequest(path, body, settings) {
  const url = `${settings.baseUrl.replace(/\/$/, '')}${path}`;
  const response = await ollamaFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, settings);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama error (${response.status}): ${text.slice(0, 200)}`);
  }
  return response.json();
}

function modelIsAvailable(available, wanted) {
  return available.some(name =>
    name === wanted || name.startsWith(`${wanted.split(':')[0]}:`)
  );
}

async function listAvailableOllamaModels(settings) {
  const base = settings.baseUrl.replace(/\/$/, '');
  const response = await ollamaFetch(`${base}/api/tags`, undefined, settings);
  if (!response.ok) {
    throw new Error(
      'Cannot reach Ollama. Start it with: ollama serve'
    );
  }
  const data = await response.json();
  return (data.models || []).map(m => m.name);
}

async function checkOllamaEmbedAvailable(settings) {
  const available = await listAvailableOllamaModels(settings);
  if (!modelIsAvailable(available, settings.embedModel)) {
    throw new Error(`Missing Ollama embed model. Run: ollama pull ${settings.embedModel}`);
  }
}

async function checkOllamaAvailable(settings) {
  const available = await listAvailableOllamaModels(settings);
  const missing = [];
  if (!modelIsAvailable(available, settings.chatModel)) {
    missing.push(settings.chatModel);
  }
  if (!modelIsAvailable(available, settings.embedModel)) {
    missing.push(settings.embedModel);
  }
  if (missing.length) {
    throw new Error(`Missing Ollama models. Run: ollama pull ${missing.join(' && ollama pull ')}`);
  }
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

async function getMessageContent(messageId, previewLength) {
  const full = await browser.messages.getFull(messageId);
  const header = full.headers?.From?.[0] || full.author || '';
  const subject = full.headers?.Subject?.[0] || full.subject || '';
  const body = truncateText(extractPlainBody(full), previewLength);
  return {
    author: header,
    subject,
    bodyPreview: body
  };
}

function buildEmbedText(entry) {
  return [
    entry.author || '',
    entry.subject || '',
    entry.bodyPreview || ''
  ].join('\n').trim();
}

function buildClassifyText(content) {
  return [
    `From: ${content.author || ''}`,
    `Subject: ${content.subject || ''}`,
    `Body: ${content.bodyPreview || ''}`
  ].join('\n');
}

async function embedText(text, settings) {
  const data = await ollamaRequest('/api/embeddings', {
    model: settings.embedModel,
    prompt: text
  }, settings);
  if (!data.embedding || !Array.isArray(data.embedding)) {
    throw new Error('Invalid embedding response from Ollama');
  }
  return data.embedding;
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

function findSimilarEntries(queryEmbedding, entries, topK) {
  const scored = entries
    .filter(e => e.embedding?.length)
    .map(entry => ({
      entry,
      score: cosineSimilarity(queryEmbedding, entry.embedding)
    }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map(s => s.entry);
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

async function rankFoldersForMessage(index, messageId, folderPaths, settings) {
  if (
    index.settings?.embedModel &&
    index.settings.embedModel !== settings.embedModel
  ) {
    throw new Error(
      `Index was built with “${index.settings.embedModel}”, but settings use “${settings.embedModel}”. ` +
      'Rebuild the index on the Training tab.'
    );
  }
  const content = await getMessageContent(messageId, settings.bodyPreviewLength);
  const queryText = buildEmbedText({
    author: content.author,
    subject: content.subject,
    bodyPreview: content.bodyPreview
  });
  const queryEmbedding = await embedText(queryText, settings);
  return scoreFoldersBySimilarity(index, queryEmbedding, folderPaths);
}

function formatExamples(examples) {
  return examples.map((ex, i) => (
    `${i + 1}. Folder: ${ex.folderPath}\n` +
    `   From: ${ex.author || '(unknown)'}\n` +
    `   Subject: ${ex.subject || '(no subject)'}\n` +
    `   Preview: ${truncateText(ex.bodyPreview, 300)}`
  )).join('\n\n');
}

function buildClassificationPrompt(folders, examples, content) {
  const folderList = folders.map(f => `- ${f}`).join('\n');
  const exampleBlock = examples.length
    ? formatExamples(examples)
    : '(no similar examples — use folder names and email content)';

  return `You classify emails into archive folders based on how the user filed similar mail before.

Allowed folders (reply with one exact path from this list only):
${folderList}

Similar archived emails:
${exampleBlock}

Email to classify:
${buildClassifyText(content)}

Reply with JSON only, no markdown:
{"folder":"<exact folder path>","confidence":<number 0-100>}`;
}

function parseClassificationResponse(text) {
  const trimmed = String(text || '').trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('LLM did not return JSON');
  }
  const parsed = JSON.parse(jsonMatch[0]);
  let confidence = Number(parsed.confidence);
  if (confidence <= 1 && confidence >= 0) {
    confidence *= 100;
  }
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(100, confidence));
  const folder = String(parsed.folder || '').trim();
  if (!folder) {
    throw new Error('LLM returned empty folder');
  }
  return { folder, confidence };
}

async function classifyWithLlm(folders, examples, content, settings) {
  const prompt = buildClassificationPrompt(folders, examples, content);
  const data = await ollamaRequest('/api/generate', {
    model: settings.chatModel,
    prompt,
    stream: false,
    format: 'json',
    options: { temperature: 0.1, num_predict: 120 }
  }, settings);
  const result = parseClassificationResponse(data.response);
  if (!folders.includes(result.folder)) {
    const match = folders.find(f =>
      f.endsWith(result.folder) || result.folder.endsWith(f) || f.includes(result.folder)
    );
    if (match) result.folder = match;
    else throw new Error(`Unknown folder from LLM: ${result.folder}`);
  }
  return result;
}

async function classifyMessageWithIndex(index, messageId, settings) {
  const content = await getMessageContent(messageId, settings.bodyPreviewLength);
  const folders = uniqueFolders(index.entries);
  if (folders.length === 0) {
    throw new Error('Index has no folders');
  }

  const queryText = buildEmbedText({
    author: content.author,
    subject: content.subject,
    bodyPreview: content.bodyPreview
  });
  const queryEmbedding = await embedText(queryText, settings);
  const topK = settings.ragTopK || RAG_TOP_K_DEFAULT;
  const examples = findSimilarEntries(queryEmbedding, index.entries, topK);

  return classifyWithLlm(folders, examples, content, settings);
}

/** Fast path: best folder from embedding similarity only (no LLM). */
async function classifyMessageRagOnly(index, messageId, settings) {
  const folders = uniqueFolders(index.entries);
  if (folders.length === 0) {
    throw new Error('Index has no folders');
  }
  const content = await getMessageContent(messageId, settings.bodyPreviewLength);
  const queryText = buildEmbedText({
    author: content.author,
    subject: content.subject,
    bodyPreview: content.bodyPreview
  });
  const queryEmbedding = await embedText(queryText, settings);
  const ranked = scoreFoldersBySimilarity(index, queryEmbedding, folders);
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

async function testOllamaConnection(settings) {
  const models = await listOllamaModels(settings);
  return { ok: true, modelCount: models.length, models };
}

window.ollamaArchive = {
  DEFAULT_OLLAMA_SETTINGS,
  getOllamaSettings,
  saveOllamaSettings,
  hostPermissionPattern,
  hasHostPermission,
  listOllamaModels,
  testOllamaConnection,
  isEmbedModelName,
  checkOllamaAvailable,
  checkOllamaEmbedAvailable,
  getMessageContent,
  buildEmbedText,
  embedText,
  embedBatch,
  classifyMessageWithIndex,
  classifyMessageRagOnly,
  rankFoldersForMessage,
  truncateText
};
