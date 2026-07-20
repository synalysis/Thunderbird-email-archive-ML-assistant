let currentAccount = null;

document.addEventListener('DOMContentLoaded', async () => {
  const accountSelect = document.getElementById('accountSelect');
  const folderTreeEl = document.getElementById('folderTree');
  const trainButton = document.getElementById('trainButton');
  const trainAllButton = document.getElementById('trainAllButton');
  const modelsList = document.getElementById('modelsList');
  const status = document.getElementById('status');
  const folderCount = document.getElementById('folderCount');
  const messageCount = document.getElementById('messageCount');
  const currentFolder = document.getElementById('currentFolder');
  const llamaStatus = document.getElementById('llamaStatus');
  const embedModelSelect = document.getElementById('embedModelSelect');
  const refreshModelsButton = document.getElementById('refreshModelsButton');
  const embedBaseUrlInput = document.getElementById('embedBaseUrl');
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
    const stored = await emailArchiveRequest('getLlamaSettings');
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
      const settings = await emailArchiveRequest('saveLlamaSettings', { settings: partial });
      updateIndexingHints(settings);
    } catch (error) {
      llamaStatus.textContent = error.message;
      llamaStatus.className = 'sync-status error';
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
      option.textContent = 'No models found — start llama-server with --embedding';
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

  async function loadModelPickers(embedUrlOverride) {
    refreshModelsButton.disabled = true;
    applyBaseUrlButton.disabled = true;
    try {
      const stored = await emailArchiveRequest('getLlamaSettings');
      const embedUrl = normalizeBaseUrl(
        embedUrlOverride || embedBaseUrlInput.value || stored.embedBaseUrl || stored.baseUrl
      );
      embedBaseUrlInput.value = embedUrl;
      const { embedModels } = await fetchLlamaTags(embedUrl);
      fillModelSelect(embedModelSelect, embedModels, stored.embedModel);
      embedModelSelect.disabled = savingModels;
    } catch (error) {
      embedModelSelect.innerHTML = '';
      const errOption = document.createElement('option');
      errOption.textContent = error.message;
      embedModelSelect.appendChild(errOption);
      embedModelSelect.disabled = true;
      llamaStatus.textContent = error.message;
      llamaStatus.className = 'sync-status error';
    } finally {
      refreshModelsButton.disabled = savingModels;
      applyBaseUrlButton.disabled = false;
    }
  }

  async function testConnection() {
    const embedUrl = normalizeBaseUrl(embedBaseUrlInput.value);
    if (!embedUrl) {
      llamaStatus.textContent = 'Enter a valid embedding server URL (e.g. http://127.0.0.1:8083).';
      llamaStatus.className = 'sync-status error';
      return;
    }
    testConnectionButton.disabled = true;
    applyBaseUrlButton.disabled = true;
    llamaStatus.textContent = 'Requesting permission and testing connection…';
    llamaStatus.className = 'sync-status';
    try {
      const parsed = new URL(embedUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('URL must start with http:// or https://');
      }
      const granted = await requestHostPermission(embedUrl);
      if (!granted) {
        throw new Error(permissionDeniedMessage(embedUrl));
      }
      const result = await fetchLlamaTags(embedUrl);
      await emailArchiveRequest('saveLlamaSettings', {
        settings: {
          embedBaseUrl: result.embedBaseUrl,
          baseUrl: result.embedBaseUrl
        }
      });
      llamaStatus.textContent =
        `Connected — ${result.embeddingDims}-dim embeddings at ${result.embedBaseUrl}`;
      llamaStatus.className = 'sync-status success';
      await loadModelPickers(result.embedBaseUrl);
    } catch (error) {
      llamaStatus.textContent = error.message;
      llamaStatus.className = 'sync-status error';
    } finally {
      testConnectionButton.disabled = false;
      applyBaseUrlButton.disabled = false;
    }
  }

  async function applyBaseUrl() {
    await testConnection();
  }

  async function saveSelectedModels() {
    if (savingModels || !embedModelSelect.value) {
      return;
    }
    savingModels = true;
    embedModelSelect.disabled = true;
    refreshModelsButton.disabled = true;
    try {
      const result = await emailArchiveRequest('saveLlamaSettings', {
        settings: {
          embedModel: embedModelSelect.value
        }
      });
      if (!result.ok) {
        llamaStatus.textContent = result.error;
        llamaStatus.className = 'sync-status error';
      } else {
        await updateLlamaStatus();
      }
    } catch (error) {
      llamaStatus.textContent = error.message;
      llamaStatus.className = 'sync-status error';
    } finally {
      savingModels = false;
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

  async function updateLlamaStatus() {
    try {
      const stored = await emailArchiveRequest('getLlamaSettings');
      const embedUrl = embedBaseUrlInput.value || stored.embedBaseUrl || stored.baseUrl;
      await fetchLlamaTags(embedUrl);
      llamaStatus.textContent =
        `Server ready — ${stored.embedModel || 'default'} @ ${embedUrl}`;
      llamaStatus.className = 'sync-status success';
    } catch (error) {
      llamaStatus.textContent = error.message;
      llamaStatus.className = 'sync-status error';
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

  embedBaseUrlInput.value = 'http://127.0.0.1:8083';
  try {
    const stored = await emailArchiveRequest('getLlamaSettings');
    embedBaseUrlInput.value = stored.embedBaseUrl || stored.baseUrl || embedBaseUrlInput.value;
  } catch (_) {
    /* use default URL */
  }
  llamaStatus.textContent = 'Click Test connection to link the llama.cpp server (required once after install).';
  llamaStatus.className = 'sync-status';
  await loadIndexSettings();
  await updateModelsList();

  embedModelSelect.addEventListener('change', saveSelectedModels);
  refreshModelsButton.addEventListener('click', async () => {
    const embedUrl = normalizeBaseUrl(embedBaseUrlInput.value);
    if (!embedUrl) {
      llamaStatus.textContent = 'Enter an embedding server URL first.';
      llamaStatus.className = 'sync-status error';
      return;
    }
    const granted = await requestHostPermission(embedUrl);
    if (!granted) {
      llamaStatus.textContent = permissionDeniedMessage(embedUrl);
      llamaStatus.className = 'sync-status error';
      return;
    }
    await loadModelPickers();
    await updateLlamaStatus();
  });
  applyBaseUrlButton.addEventListener('click', testConnection);
  testConnectionButton.addEventListener('click', testConnection);
  embedBaseUrlInput.addEventListener('keydown', event => {
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
      status.textContent = 'Indexing archive folders (llama.cpp)…';
      status.className = '';
      await updateLlamaStatus();

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
      trainAllButton.disabled = false;
    }
  });

  trainAllButton.addEventListener('click', async () => {
    try {
      trainButton.disabled = true;
      trainAllButton.disabled = true;
      status.textContent = 'Indexing all accounts (llama.cpp)…';
      status.className = '';
      await updateLlamaStatus();

      const result = await emailArchiveRequest('trainAllAccounts');
      const parts = [];
      if (result.trainedCount) {
        parts.push(`${result.trainedCount} indexed`);
      }
      if (result.skippedCount) {
        parts.push(`${result.skippedCount} skipped (no folders selected)`);
      }
      if (result.failedCount) {
        parts.push(`${result.failedCount} failed`);
      }
      status.textContent = `All accounts: ${parts.join(', ') || 'nothing to do'}.`;
      status.className = result.failedCount ? 'error' : 'success';
      await updateModelsList();
    } catch (error) {
      console.error('Indexing all accounts error:', error);
      status.textContent = `Error: ${error.message}`;
      status.className = 'error';
    } finally {
      trainButton.disabled = false;
      trainAllButton.disabled = false;
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
    } else if (message.type === 'training-account-start') {
      currentFolder.textContent =
        `Account ${message.accountIndex}/${message.accountTotal}: ${message.accountName}…`;
      currentFolder.className = 'sync-status warning';
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
