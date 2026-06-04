let currentAccount = null;

document.addEventListener('DOMContentLoaded', async () => {
  const accountSelect = document.getElementById('accountSelect');
  const folderTreeEl = document.getElementById('folderTree');
  const trainButton = document.getElementById('trainButton');
  const modelsList = document.getElementById('modelsList');
  const status = document.getElementById('status');
  const folderCount = document.getElementById('folderCount');
  const messageCount = document.getElementById('messageCount');
  const currentFolder = document.getElementById('currentFolder');
  const ollamaStatus = document.getElementById('ollamaStatus');
  const chatModelSelect = document.getElementById('chatModelSelect');
  const embedModelSelect = document.getElementById('embedModelSelect');
  const refreshModelsButton = document.getElementById('refreshModelsButton');
  const ollamaBaseUrl = document.getElementById('ollamaBaseUrl');
  const applyBaseUrlButton = document.getElementById('applyBaseUrlButton');
  const testConnectionButton = document.getElementById('testConnectionButton');
  const maxSamplesPerFolderInput = document.getElementById('maxSamplesPerFolder');
  const maxTotalIndexEntriesInput = document.getElementById('maxTotalIndexEntries');
  const indexingHint = document.getElementById('indexingHint');
  const indexCapHint = document.getElementById('indexCapHint');
  let savingModels = false;
  let savingIndexSettings = false;

  function updateIndexingHints(settings) {
    const per = settings.maxSamplesPerFolder;
    const cap = settings.maxTotalIndexEntries;
    indexingHint.innerHTML =
      `Indexing samples up to <strong>${per} messages per selected folder</strong> ` +
      '(all folders are covered; rebuild the index after changing this).';
    if (cap > 0) {
      indexCapHint.textContent =
        `Global cap: ${cap} messages total — with many folders, each may get fewer than ${per}. ` +
        'Use 0 for no limit.';
      indexCapHint.className = 'sync-status warning';
    } else {
      indexCapHint.textContent =
        'No global cap — every selected folder can use the full per-folder sample count.';
      indexCapHint.className = 'sync-status';
    }
  }

  function readIndexSettingsFromInputs() {
    return {
      maxSamplesPerFolder: parseInt(maxSamplesPerFolderInput.value, 10),
      maxTotalIndexEntries: parseInt(maxTotalIndexEntriesInput.value, 10)
    };
  }

  async function loadIndexSettings() {
    const stored = await emailArchiveRequest('getOllamaSettings');
    maxSamplesPerFolderInput.value = String(stored.maxSamplesPerFolder);
    maxTotalIndexEntriesInput.value = String(stored.maxTotalIndexEntries);
    updateIndexingHints(stored);
  }

  async function saveIndexSettings() {
    if (savingIndexSettings) {
      return;
    }
    const partial = readIndexSettingsFromInputs();
    if (!Number.isFinite(partial.maxSamplesPerFolder) || partial.maxSamplesPerFolder < 1) {
      return;
    }
    if (!Number.isFinite(partial.maxTotalIndexEntries) || partial.maxTotalIndexEntries < 0) {
      return;
    }
    savingIndexSettings = true;
    maxSamplesPerFolderInput.disabled = true;
    maxTotalIndexEntriesInput.disabled = true;
    try {
      const settings = await emailArchiveRequest('saveOllamaSettings', { settings: partial });
      updateIndexingHints(settings);
    } catch (error) {
      ollamaStatus.textContent = error.message;
      ollamaStatus.className = 'sync-status error';
    } finally {
      savingIndexSettings = false;
      maxSamplesPerFolderInput.disabled = false;
      maxTotalIndexEntriesInput.disabled = false;
    }
  }

  function fillModelSelect(select, modelNames, selected) {
    const names = [...modelNames];
    if (selected && !names.includes(selected)) {
      names.push(selected);
      names.sort();
    }
    select.innerHTML = '';
    if (names.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No models found — run ollama pull …';
      select.appendChild(option);
      select.disabled = true;
      return;
    }
    select.disabled = false;
    for (const name of names) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    }
    if (selected && names.includes(selected)) {
      select.value = selected;
    }
  }

  async function loadModelPickers(baseUrlOverride) {
    refreshModelsButton.disabled = true;
    applyBaseUrlButton.disabled = true;
    try {
      const stored = await emailArchiveRequest('getOllamaSettings');
      const baseUrl = normalizeBaseUrl(baseUrlOverride || ollamaBaseUrl.value || stored.baseUrl);
      ollamaBaseUrl.value = baseUrl;
      const { chatModels, embedModels } = await fetchOllamaTags(baseUrl);
      fillModelSelect(chatModelSelect, chatModels, stored.chatModel);
      fillModelSelect(embedModelSelect, embedModels, stored.embedModel);
      chatModelSelect.disabled = savingModels;
      embedModelSelect.disabled = savingModels;
    } catch (error) {
      chatModelSelect.innerHTML = '';
      embedModelSelect.innerHTML = '';
      const errOption = document.createElement('option');
      errOption.textContent = error.message;
      chatModelSelect.appendChild(errOption);
      embedModelSelect.appendChild(document.createElement('option'));
      chatModelSelect.disabled = true;
      embedModelSelect.disabled = true;
      ollamaStatus.textContent = error.message;
      ollamaStatus.className = 'sync-status error';
    } finally {
      refreshModelsButton.disabled = savingModels;
      applyBaseUrlButton.disabled = false;
    }
  }

  async function testConnection() {
    const baseUrl = normalizeBaseUrl(ollamaBaseUrl.value);
    if (!baseUrl) {
      ollamaStatus.textContent = 'Enter a valid Ollama URL (e.g. http://127.0.0.1:11434).';
      ollamaStatus.className = 'sync-status error';
      return;
    }
    testConnectionButton.disabled = true;
    applyBaseUrlButton.disabled = true;
    ollamaStatus.textContent = 'Requesting permission and testing connection…';
    ollamaStatus.className = 'sync-status';
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('URL must start with http:// or https://');
      }
      const { all, baseUrl: connectedUrl } = await fetchOllamaTags(baseUrl);
      await emailArchiveRequest('saveOllamaSettings', { settings: { baseUrl: connectedUrl } });
      ollamaStatus.textContent =
        `Connected — ${all.length} model(s) at ${connectedUrl}`;
      ollamaStatus.className = 'sync-status success';
      await loadModelPickers(connectedUrl);
    } catch (error) {
      ollamaStatus.textContent = error.message;
      ollamaStatus.className = 'sync-status error';
    } finally {
      testConnectionButton.disabled = false;
      applyBaseUrlButton.disabled = false;
    }
  }

  async function applyBaseUrl() {
    await testConnection();
  }

  async function saveSelectedModels() {
    if (savingModels || !chatModelSelect.value || !embedModelSelect.value) {
      return;
    }
    savingModels = true;
    chatModelSelect.disabled = true;
    embedModelSelect.disabled = true;
    refreshModelsButton.disabled = true;
    try {
      const result = await emailArchiveRequest('saveOllamaSettings', {
        settings: {
          chatModel: chatModelSelect.value,
          embedModel: embedModelSelect.value
        }
      });
      if (!result.ok) {
        ollamaStatus.textContent = result.error;
        ollamaStatus.className = 'sync-status error';
      } else {
        await updateOllamaStatus();
      }
    } catch (error) {
      ollamaStatus.textContent = error.message;
      ollamaStatus.className = 'sync-status error';
    } finally {
      savingModels = false;
      chatModelSelect.disabled = false;
      embedModelSelect.disabled = false;
      refreshModelsButton.disabled = false;
    }
  }

  const accounts = await browser.accounts.list(true);
  for (const account of accounts) {
    const option = document.createElement('option');
    option.value = account.id;
    option.textContent = account.name;
    accountSelect.appendChild(option);
  }

  async function updateOllamaStatus() {
    try {
      const stored = await emailArchiveRequest('getOllamaSettings');
      await fetchOllamaTags(ollamaBaseUrl.value || stored.baseUrl);
      ollamaStatus.textContent =
        `Ollama ready — ${stored.chatModel}, ${stored.embedModel}`;
      ollamaStatus.className = 'sync-status success';
    } catch (error) {
      ollamaStatus.textContent = error.message;
      ollamaStatus.className = 'sync-status error';
    }
  }

  async function updateModelsList() {
    const trainedAccountIds = await emailArchiveRequest('getTrainedAccounts');
    modelsList.innerHTML = '';

    if (trainedAccountIds.length === 0) {
      modelsList.innerHTML = '<div class="model-item">No indexed accounts yet</div>';
      return;
    }

    for (const accountId of trainedAccountIds) {
      const account = accounts.find(a => a.id === accountId);
      if (!account) continue;
      const div = document.createElement('div');
      div.className = 'model-item';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = account.name;
      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = 'Delete';
      deleteBtn.onclick = async () => {
        await emailArchiveRequest('deleteModel', { accountId });
        await updateModelsList();
      };
      div.appendChild(nameSpan);
      div.appendChild(deleteBtn);
      modelsList.appendChild(div);
    }
  }

  ollamaBaseUrl.value = 'http://127.0.0.1:11434';
  try {
    const stored = await emailArchiveRequest('getOllamaSettings');
    ollamaBaseUrl.value = stored.baseUrl || ollamaBaseUrl.value;
  } catch (_) {
    /* use default URL */
  }
  ollamaStatus.textContent = 'Click Test connection to link Ollama (required once after install).';
  ollamaStatus.className = 'sync-status';
  await loadIndexSettings();
  await updateModelsList();

  chatModelSelect.addEventListener('change', saveSelectedModels);
  embedModelSelect.addEventListener('change', saveSelectedModels);
  refreshModelsButton.addEventListener('click', async () => {
    await loadModelPickers();
    await updateOllamaStatus();
  });
  applyBaseUrlButton.addEventListener('click', testConnection);
  testConnectionButton.addEventListener('click', testConnection);
  ollamaBaseUrl.addEventListener('keydown', event => {
    if (event.key === 'Enter') testConnection();
  });
  maxSamplesPerFolderInput.addEventListener('change', saveIndexSettings);
  maxTotalIndexEntriesInput.addEventListener('change', saveIndexSettings);

  async function loadFolders(account) {
    const folders = await emailArchiveRequest('getFoldersWithState', { account });
    const folderMap = new Map();
    const rootFolders = [];

    folders.forEach(folder => {
      const pathParts = folder.path.split('/');
      const folderName = pathParts[pathParts.length - 1];
      const parentPath = pathParts.slice(0, -1).join('/');
      const folderNode = {
        ...folder,
        name: folderName,
        children: [],
        level: pathParts.length - 1
      };
      folderMap.set(folder.path, folderNode);
      if (parentPath) {
        const parentNode = folderMap.get(parentPath);
        if (parentNode) parentNode.children.push(folderNode);
      } else {
        rootFolders.push(folderNode);
      }
    });

    folderTreeEl.innerHTML = '';

    function renderFolder(folder, level = 0) {
      const div = document.createElement('div');
      div.className = 'folder-item';
      div.style.paddingLeft = `${level * 20}px`;
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = folder.path;
      checkbox.checked = folder.selected;
      checkbox.id = `folder-${folder.path}`;
      checkbox.addEventListener('change', async () => {
        const node = folderMap.get(folder.path);
        if (node) node.selected = checkbox.checked;
        const updatedStructure = Array.from(folderMap.values()).map(f => ({
          path: f.path,
          name: f.name,
          selected: f.selected
        }));
        await emailArchiveRequest('saveFolderStructure', {
          accountId: account.id,
          folders: updatedStructure
        });
      });
      const label = document.createElement('label');
      label.htmlFor = checkbox.id;
      label.textContent = folder.name;
      div.appendChild(checkbox);
      div.appendChild(label);
      folderTreeEl.appendChild(div);
      folder.children?.forEach(child => renderFolder(child, level + 1));
    }

    rootFolders.forEach(folder => renderFolder(folder));
  }

  accountSelect.addEventListener('change', async () => {
    currentAccount = accounts.find(acc => acc.id === accountSelect.value) || null;
    if (currentAccount) await loadFolders(currentAccount);
  });

  trainButton.addEventListener('click', async () => {
    if (!currentAccount) {
      status.textContent = 'Select an account first.';
      status.className = 'error';
      return;
    }
    const selectedPaths = Array.from(
      folderTreeEl.querySelectorAll('input[type="checkbox"]:checked')
    ).map(cb => cb.value);

    if (selectedPaths.length === 0) {
      status.textContent = 'Select at least one folder.';
      status.className = 'error';
      return;
    }

    try {
      trainButton.disabled = true;
      status.textContent = 'Indexing archive folders (Ollama)…';
      status.className = '';
      await updateOllamaStatus();

      const stored = await emailArchiveRequest('getOllamaSettings');
      await fetchOllamaTags(ollamaBaseUrl.value || stored.baseUrl);

      const result = await emailArchiveRequest('trainModel', {
        account: currentAccount,
        selectedFolderPaths: selectedPaths
      });

      if (result.success) {
        status.textContent =
          `Index built — ${result.messagesProcessed} messages embedded ` +
          `from ${result.foldersWithSamples} of ${result.foldersTotal} folders ` +
          `(up to ${result.samplesPerFolder} per folder).`;
        status.className = 'success';
        await updateModelsList();
      }
    } catch (error) {
      console.error('Indexing error:', error);
      status.textContent = `Error: ${error.message}`;
      status.className = 'error';
    } finally {
      trainButton.disabled = false;
    }
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) {
      return;
    }
    const message = event.data;
    if (message.type === 'training-progress') {
      const { folderProgress, messageProgress } = message;
      folderCount.textContent = `${folderProgress.current} / ${folderProgress.total}`;
      messageCount.textContent = `${messageProgress.current} / ${messageProgress.total}`;
      currentFolder.textContent = `Folder: ${folderProgress.currentFolder}`;
    } else if (message.type === 'folder-sync-start') {
      currentFolder.textContent = `Reading: ${message.folder}…`;
      currentFolder.className = 'sync-status warning';
    } else if (message.type === 'folder-sync-complete') {
      currentFolder.textContent = `Done: ${message.folder}`;
      currentFolder.className = 'sync-status success';
    }
  });

  document.getElementById('selectAllFolders').addEventListener('click', () => {
    folderTreeEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.checked = true;
    });
  });

  document.getElementById('deselectAllFolders').addEventListener('click', () => {
    folderTreeEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.checked = false;
    });
  });
});
