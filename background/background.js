const MENU_ID = 'email-archive-assistant';
const MENU_MOVE_TO_PARENT = 'email-archive-move-to';
const MENU_FILTER_FOLDERS = 'email-archive-filter-folders';
const FOLDER_MENU_PREFIX = 'email-archive-f-';
const MAX_CONTEXT_MENU_FOLDERS = 25;

let learnFolderPathsForMenu = [];
let folderPickerPending = null;

function messagesFromList(messageList) {
  if (!messageList?.messages?.length) {
    return [];
  }
  return [...messageList.messages];
}

function isInboxFolder(folder) {
  return folder?.specialUse?.includes('inbox') ?? false;
}

async function notifyUser(message) {
  try {
    await browser.notifications.create({
      type: 'basic',
      title: 'Email Archive Assistant',
      message
    });
  } catch (err) {
    console.error('Notification failed:', err);
  }
}

function formatFolderMenuTitle(path, allPaths, score) {
  const name = path.split('/').pop() || path;
  const sameName = allPaths.filter(p => (p.split('/').pop() || p) === name);
  if (sameName.length <= 1) {
    return name;
  }
  const parent = path.split('/').slice(-2, -1)[0];
  const label = parent ? `${name} — ${parent}` : path;
  if (score > 0) {
    return `${Math.round(score * 100)}%  ${label}`;
  }
  return label;
}

function sortFoldersByScore(folders) {
  return [...folders].sort((a, b) => {
    const scoreA = Number(a.score) || 0;
    const scoreB = Number(b.score) || 0;
    if (scoreB !== scoreA) {
      return scoreB - scoreA;
    }
    const nameA = (a.path.split('/').pop() || a.path).toLowerCase();
    const nameB = (b.path.split('/').pop() || b.path).toLowerCase();
    return nameA.localeCompare(nameB);
  });
}

async function getSelectableArchiveFolders(accountId) {
  const paths = new Set();
  try {
    const index = await loadIndex(accountId);
    index.entries.forEach(entry => {
      if (entry.folderPath) {
        paths.add(entry.folderPath);
      }
    });
  } catch (_) {
    /* index may not exist yet */
  }
  const saved = await loadFolderStructure(accountId);
  if (saved?.length) {
    saved
      .filter(folder => folder.selected !== false)
      .forEach(folder => paths.add(folder.path));
  }
  if (paths.size === 0) {
    const allFolders = await browser.folders.query({ accountId });
    allFolders
      .filter(folder => !folder.isVirtual && !folder.isTag && !folder.isUnified)
      .filter(folder => !isDefaultFolder(folder))
      .forEach(folder => paths.add(folder.path));
  }
  const sorted = [...paths].sort((a, b) => {
    const nameA = (a.split('/').pop() || a).toLowerCase();
    const nameB = (b.split('/').pop() || b).toLowerCase();
    return nameA.localeCompare(nameB);
  });
  return sorted.map(path => ({ path, score: 0 }));
}

async function getFoldersForContextMenu(accountId, messages) {
  const folders = await getSelectableArchiveFolders(accountId);
  const paths = folders.map(f => f.path);
  if (!paths.length || !messages.length) {
    return [];
  }
  if (!(await hasTrainedModel(accountId))) {
    return sortFoldersByScore(paths.map(path => ({
      path,
      score: 0,
      title: formatFolderMenuTitle(path, paths, 0)
    })));
  }
  try {
    const settings = await ollamaArchive.getOllamaSettings();
    await ollamaArchive.checkOllamaEmbedAvailable(settings);
    const index = await loadIndex(accountId);
    const ranked = await ollamaArchive.rankFoldersForMessage(
      index,
      messages[0].id,
      paths,
      settings
    );
    return sortFoldersByScore(ranked.map(({ path, score }) => ({
      path,
      score,
      title: formatFolderMenuTitle(path, paths, score)
    })));
  } catch (error) {
    console.warn('Folder ranking failed, using alphabetical order:', error);
    return sortFoldersByScore(paths.map(path => ({
      path,
      score: 0,
      title: formatFolderMenuTitle(path, paths, 0),
      rankingError: error.message
    })));
  }
}

async function ensureIndex(accountId) {
  try {
    return await loadIndex(accountId);
  } catch (_) {
    const settings = await ollamaArchive.getOllamaSettings();
    return {
      version: 1,
      accountId,
      updatedAt: Date.now(),
      settings: {
        chatModel: settings.chatModel,
        embedModel: settings.embedModel
      },
      entries: []
    };
  }
}

async function addLearnedEntry(index, messageId, folderPath, settings) {
  const content = await ollamaArchive.getMessageContent(
    messageId,
    settings.bodyPreviewLength
  );
  const embedText = ollamaArchive.buildEmbedText({
    author: content.author,
    subject: content.subject,
    bodyPreview: content.bodyPreview
  });
  const embedding = await ollamaArchive.embedText(embedText, settings);
  index.entries = index.entries.filter(entry => entry.messageId !== messageId);
  index.entries.push({
    messageId,
    folderPath,
    author: content.author,
    subject: content.subject,
    bodyPreview: content.bodyPreview,
    embedding
  });
}

async function accountIdFromMessageHeader(message) {
  if (message?.folder?.accountId) {
    return message.folder.accountId;
  }
  if (message?.folder?.id) {
    const folder = await browser.folders.get(message.folder.id);
    return folder.accountId;
  }
  const header = await browser.messages.get(message.id);
  if (!header?.folder) {
    throw new Error('Could not read message folder');
  }
  if (header.folder.accountId) {
    return header.folder.accountId;
  }
  const folder = await browser.folders.get(header.folder.id);
  return folder.accountId;
}

async function learnAndMoveMessages(accountId, messageIds, folderPath, notify = true) {
  if (!accountId || !folderPath || !messageIds?.length) {
    throw new Error('No message or folder selected.');
  }

  const settings = await ollamaArchive.getOllamaSettings();
  await ollamaArchive.checkOllamaAvailable(settings);
  let index = await ensureIndex(accountId);
  let moved = 0;
  let learned = 0;

  for (const messageId of messageIds) {
    await addLearnedEntry(index, messageId, folderPath, settings);
    learned++;
    const results = await moveMessages(accountId, [{
      id: messageId,
      predictedFolder: folderPath
    }]);
    if (results[0]?.success) {
      moved++;
    }
  }

  index.updatedAt = Date.now();
  await saveIndex(accountId, index);

  const folderName = folderPath.split('/').pop() || folderPath;
  let summary;
  if (moved === messageIds.length) {
    summary = `Moved ${moved} message(s) to ${folderName} and updated the index.`;
  } else {
    summary = `Learned ${learned} example(s) for ${folderName}. Moved ${moved} of ${messageIds.length}.`;
  }
  if (notify) {
    await notifyUser(summary);
  }
  return { moved, learned, total: messageIds.length, summary };
}

async function learnAndMoveFromContext(info, folderPath) {
  const accountId = info.displayedFolder?.accountId;
  const toProcess = messagesFromList(info.selectedMessages);
  try {
    await learnAndMoveMessages(
      accountId,
      toProcess.map(m => m.id),
      folderPath,
      true
    );
  } catch (error) {
    console.error('Learn and move failed:', error);
    await notifyUser(error.message);
  }
}

function setFolderPickerPending(accountId, messageIds) {
  folderPickerPending = {
    accountId,
    messageIds,
    openedAt: Date.now()
  };
}

async function openFolderPickerPopup() {
  try {
    const opened = await browser.messageDisplayAction.openPopup();
    if (!opened) {
      await notifyUser(
        'Could not open folder picker. Add “Archive to folder” to the message toolbar (⋯ Customize).'
      );
    }
  } catch (error) {
    console.error('openPopup failed:', error);
    await notifyUser(error.message);
  }
}

async function getFolderPickerContext() {
  if (folderPickerPending) {
    const ctx = folderPickerPending;
    folderPickerPending = null;
    return {
      accountId: ctx.accountId,
      messageIds: ctx.messageIds
    };
  }

  const displayed = await browser.messageDisplay.getDisplayedMessages();
  const messages = messagesFromList(displayed);
  if (!messages.length) {
    throw new Error('Open a message, or select messages in Inbox and use “Filter folders…”.');
  }
  const accountId = await accountIdFromMessageHeader(messages[0]);
  return {
    accountId,
    messageIds: messages.map(m => m.id)
  };
}

async function listRankedFolders(accountId, messageId) {
  const folders = await getFoldersForContextMenu(accountId, [{ id: messageId }]);
  const ranked = folders.some(f => (Number(f.score) || 0) > 0);
  const rankingError = folders.find(f => f.rankingError)?.rankingError || null;
  return {
    folders,
    ranked,
    rankingError
  };
}

const FOLDER_PICKER_ADVANCE_MS = 150;
const FOLDER_PICKER_ADVANCE_ATTEMPTS = 12;

async function refreshFolderPickerAfterMove(movedMessageIds) {
  const moved = new Set(movedMessageIds || []);
  for (let attempt = 0; attempt < FOLDER_PICKER_ADVANCE_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise(resolve => setTimeout(resolve, FOLDER_PICKER_ADVANCE_MS));
    }
    const displayed = await browser.messageDisplay.getDisplayedMessages();
    const messages = messagesFromList(displayed);
    if (!messages.length) {
      return { close: true };
    }
    const nextMessages = messages.filter(m => !moved.has(m.id));
    if (!nextMessages.length) {
      continue;
    }
    const accountId = await accountIdFromMessageHeader(nextMessages[0]);
    const folders = await getFoldersForContextMenu(accountId, nextMessages);
    const ranked = folders.some(f => (Number(f.score) || 0) > 0);
    const rankingError = folders.find(f => f.rankingError)?.rankingError || null;
    return {
      close: false,
      accountId,
      messageIds: nextMessages.map(m => m.id),
      folders,
      ranked,
      rankingError
    };
  }
  return { close: true };
}

async function removeDynamicFolderMenuItems(menuIds) {
  for (const menuId of menuIds) {
    if (String(menuId).startsWith(FOLDER_MENU_PREFIX)) {
      try {
        await browser.menus.remove(menuId);
      } catch (_) {
        /* already removed */
      }
    }
  }
}

async function rebuildMessageListMenus(info) {
  await removeDynamicFolderMenuItems(info.menuIds || []);
  learnFolderPathsForMenu = [];

  const accountId = info.displayedFolder?.accountId;
  const inInbox = isInboxFolder(info.displayedFolder);
  const hasMessages = messagesFromList(info.selectedMessages).length > 0;
  let folders = [];

  if (inInbox && accountId && hasMessages) {
    folders = await getFoldersForContextMenu(
      accountId,
      messagesFromList(info.selectedMessages)
    );
  }

  await browser.menus.update(MENU_MOVE_TO_PARENT, {
    enabled: folders.length > 0
  });

  const menuFolders = folders.slice(0, MAX_CONTEXT_MENU_FOLDERS);
  learnFolderPathsForMenu = menuFolders.map(f => f.path);
  for (let i = 0; i < menuFolders.length; i++) {
    await browser.menus.create({
      id: `${FOLDER_MENU_PREFIX}${i}`,
      parentId: MENU_MOVE_TO_PARENT,
      title: menuFolders[i].title,
      contexts: ['message_list']
    });
  }

  const filterTitle = folders.length > MAX_CONTEXT_MENU_FOLDERS
    ? `Filter folders… (${folders.length} total)`
    : 'Filter folders…';
  await browser.menus.update(MENU_FILTER_FOLDERS, {
    enabled: folders.length > 0,
    title: filterTitle
  });
  await browser.menus.refresh();
}

const TOOLS_MENU_IDS = [
  `${MENU_ID}-tools-sep`,
  MENU_ID,
  `${MENU_ID}-settings`
];

async function registerMenus() {
  for (const id of [...TOOLS_MENU_IDS, MENU_MOVE_TO_PARENT, MENU_FILTER_FOLDERS]) {
    try {
      await browser.menus.remove(id);
    } catch (_) {
      /* menu may not exist yet */
    }
  }
  // tools_menu only — do not add action context (conflicts with default_popup).
  await browser.menus.create({
    id: `${MENU_ID}-tools-sep`,
    type: 'separator',
    contexts: ['tools_menu']
  });
  await browser.menus.create({
    id: MENU_ID,
    title: 'Open Email Archive Assistant',
    contexts: ['tools_menu']
  });
  await browser.menus.create({
    id: `${MENU_ID}-settings`,
    title: 'Email Archive Assistant settings',
    contexts: ['tools_menu']
  });
  await browser.menus.create({
    id: MENU_MOVE_TO_PARENT,
    title: 'Archive to folder',
    contexts: ['message_list']
  });
  await browser.menus.create({
    id: MENU_FILTER_FOLDERS,
    parentId: MENU_MOVE_TO_PARENT,
    title: 'Filter folders…',
    contexts: ['message_list']
  });
}

let menusInitPromise = null;

function ensureMenusRegistered() {
  if (!menusInitPromise) {
    menusInitPromise = registerMenus()
      .then(() => {
        console.info('Email Archive Assistant: Tools menu entries registered');
      })
      .catch(async err => {
        menusInitPromise = null;
        console.error('Menu registration failed:', err);
        await notifyUser(
          `Tools menu entries could not be registered (${err.message}). Use the toolbar icon or Alt+Shift+A.`
        );
        throw err;
      });
  }
  return menusInitPromise;
}

browser.runtime.onInstalled.addListener(async details => {
  try {
    await ensureMenusRegistered();
    if (details.reason === 'install') {
      await notifyUser(
        'Email Archive Assistant installed. Use the toolbar icon, Add-ons → Preferences, or ≡ → Tools.'
      );
    }
  } catch (_) {
    /* notification already shown */
  }
});

browser.runtime.onStartup.addListener(() => {
  ensureMenusRegistered().catch(() => {});
});

ensureMenusRegistered().catch(() => {});

browser.commands.onCommand.addListener(command => {
  if (command === 'open-assistant') {
    openAssistant().catch(err => console.error('open-assistant command failed:', err));
  }
});

browser.menus.onShown.addListener(async (info) => {
  if (!info.menuIds?.includes(MENU_MOVE_TO_PARENT)) {
    return;
  }
  try {
    await rebuildMessageListMenus(info);
  } catch (error) {
    console.error('Menu rebuild failed:', error);
  }
});

browser.menus.onClicked.addListener(async (info) => {
  if (info.menuItemId === MENU_ID) {
    await openAssistant();
  } else if (info.menuItemId === `${MENU_ID}-settings`) {
    await openSettings();
  } else if (info.menuItemId === MENU_FILTER_FOLDERS) {
    const accountId = info.displayedFolder?.accountId;
    const selected = messagesFromList(info.selectedMessages);
    if (!accountId || !selected.length) {
      await notifyUser('Select at least one message in Inbox.');
      return;
    }
    setFolderPickerPending(accountId, selected.map(m => m.id));
    await openFolderPickerPopup();
  } else if (String(info.menuItemId).startsWith(FOLDER_MENU_PREFIX)) {
    const index = parseInt(String(info.menuItemId).slice(FOLDER_MENU_PREFIX.length), 10);
    const folderPath = learnFolderPathsForMenu[index];
    if (folderPath) {
      await learnAndMoveFromContext(info, folderPath);
    }
  }
});


const indexCache = new Map();

function indexStorageKey(accountId) {
  return `index_${accountId}`;
}

async function loadIndex(accountId) {
  if (indexCache.has(accountId)) {
    return indexCache.get(accountId);
  }
  const data = await browser.storage.local.get(indexStorageKey(accountId));
  const raw = data[indexStorageKey(accountId)];
  if (!raw) {
    throw new Error('No archive index for this account. Build the index on the Training tab first.');
  }
  const index = typeof raw === 'string' ? JSON.parse(raw) : raw;
  indexCache.set(accountId, index);
  return index;
}

async function saveIndex(accountId, index) {
  await browser.storage.local.set({
    [indexStorageKey(accountId)]: JSON.stringify(index)
  });
  indexCache.set(accountId, index);
  await registerTrainedAccount(accountId);
}

async function deleteIndex(accountId) {
  await browser.storage.local.remove(indexStorageKey(accountId));
  await browser.storage.local.remove(`model_${accountId}`);
  indexCache.delete(accountId);
  const data = await browser.storage.local.get('trainedAccounts');
  const accounts = (data.trainedAccounts || []).filter(id => id !== accountId);
  await browser.storage.local.set({ trainedAccounts: accounts });
}

async function registerTrainedAccount(accountId) {
  const data = await browser.storage.local.get('trainedAccounts');
  const accounts = data.trainedAccounts || [];
  if (!accounts.includes(accountId)) {
    accounts.push(accountId);
    await browser.storage.local.set({ trainedAccounts: accounts });
  }
}

async function saveFolderStructure(accountId, folders) {
  try {
    const normalized = folders.map(f =>
      typeof f === 'string' ? { path: f, name: f.split('/').pop(), selected: true } : f
    );
    await browser.storage.local.set({
      [`folders_${accountId}`]: JSON.stringify(normalized)
    });
    return true;
  } catch (error) {
    console.error('Error saving folder structure:', error);
    return false;
  }
}

async function loadFolderStructure(accountId) {
  try {
    const data = await browser.storage.local.get(`folders_${accountId}`);
    const raw = data[`folders_${accountId}`];
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.error('Error loading folder structure:', error);
    return null;
  }
}

async function getFoldersWithState(account) {
  const folders = await getAllFolders(account);
  const savedStructure = await loadFolderStructure(account.id);
  const savedFolderMap = new Map();
  if (savedStructure) {
    savedStructure.forEach(folder => {
      savedFolderMap.set(folder.path, folder.selected);
    });
  }
  return folders.map(folder => ({
    path: folder.path,
    name: folder.name,
    selected: savedFolderMap.has(folder.path)
      ? savedFolderMap.get(folder.path)
      : !folder.isDefault
  }));
}

async function getAllFolders(account) {
  const allFolders = await browser.folders.query({ accountId: account.id });
  return allFolders
    .filter(folder => !folder.isVirtual && !folder.isTag && !folder.isUnified)
    .map(folder => ({
      path: folder.path,
      name: folder.name,
      isDefault: isDefaultFolder(folder)
    }));
}

function isDefaultFolder(folder) {
  if (folder.specialUse?.length) {
    return true;
  }
  const systemFolders = ['Inbox', 'Sent', 'Drafts', 'Trash', 'Templates', 'Archives', 'Junk'];
  return systemFolders.includes(folder.name);
}

const ASSISTANT_URL = 'pages/container.html';

async function openAssistant() {
  const url = browser.runtime.getURL(ASSISTANT_URL);
  try {
    await browser.tabs.create({ url, active: true });
    return;
  } catch (tabsError) {
    console.warn('tabs.create failed, trying windows.create:', tabsError);
  }
  if (browser.windows?.create) {
    await browser.windows.create({ url, type: 'normal' });
    return;
  }
  throw new Error('Could not open assistant window');
}

async function openSettings() {
  await openAssistant();
}

function sendProgress(payload) {
  browser.runtime.sendMessage(payload).catch(() => {});
}

async function collectMessagesFromFolder(folderId) {
  const collected = [];
  let page = await browser.messages.list(folderId);
  while (page) {
    if (page.messages?.length) {
      collected.push(...page.messages);
    }
    page = page.id ? await browser.messages.continueList(page.id) : null;
  }
  return collected;
}

function sampleMessages(messages, maxPerFolder) {
  if (messages.length <= maxPerFolder) return messages;
  const step = Math.floor(messages.length / maxPerFolder);
  const sampled = [];
  for (let i = 0; i < messages.length && sampled.length < maxPerFolder; i += Math.max(1, step)) {
    sampled.push(messages[i]);
  }
  return sampled;
}

function samplesPerFolderForIndex(settings, folderCount) {
  const perFolder = settings.maxSamplesPerFolder;
  const cap = settings.maxTotalIndexEntries;
  if (!cap || cap <= 0 || folderCount <= 0) {
    return perFolder;
  }
  return Math.min(perFolder, Math.max(1, Math.floor(cap / folderCount)));
}

async function trainModel(account, selectedFolderPaths) {
  const settings = await ollamaArchive.getOllamaSettings();
  await ollamaArchive.checkOllamaAvailable(settings);

  const allFolders = await browser.folders.query({
    accountId: account.id,
    hasMessages: true
  });
  const folderMap = new Map(allFolders.map(f => [f.path, f]));

  const entries = [];
  const folderPaths = selectedFolderPaths.filter(p => folderMap.has(p));
  const samplesPerFolder = samplesPerFolderForIndex(settings, folderPaths.length);
  const estimatedMessages = folderPaths.length * samplesPerFolder;
  let processedFolders = 0;
  let processedMessages = 0;
  let foldersWithSamples = 0;

  for (const folderPath of folderPaths) {
    const folder = folderMap.get(folderPath);
    processedFolders++;
    sendProgress({
      type: 'folder-sync-start',
      folder: folderPath
    });

    const allMessages = await collectMessagesFromFolder(folder.id);
    const toIndex = sampleMessages(allMessages, samplesPerFolder);

    sendProgress({
      type: 'folder-sync-complete',
      folder: folderPath
    });

    if (toIndex.length > 0) {
      foldersWithSamples++;
    }

    for (const message of toIndex) {
      try {
        const content = await ollamaArchive.getMessageContent(
          message.id,
          settings.bodyPreviewLength
        );
        const embedText = ollamaArchive.buildEmbedText({
          author: content.author,
          subject: content.subject,
          bodyPreview: content.bodyPreview
        });
        const embedding = await ollamaArchive.embedText(embedText, settings);
        entries.push({
          messageId: message.id,
          folderPath,
          author: content.author,
          subject: content.subject,
          bodyPreview: content.bodyPreview,
          embedding
        });
        processedMessages++;
        sendProgress({
          type: 'training-progress',
          folderProgress: {
            current: processedFolders,
            total: folderPaths.length,
            currentFolder: folderPath
          },
          messageProgress: {
            current: processedMessages,
            total: estimatedMessages,
            currentFolder: folderPath
          }
        });
      } catch (err) {
        console.error('Error indexing message:', err);
      }
    }
  }

  if (entries.length === 0) {
    throw new Error('No messages could be indexed in the selected folders');
  }

  const index = {
    version: 1,
    accountId: account.id,
    updatedAt: Date.now(),
    settings: {
      chatModel: settings.chatModel,
      embedModel: settings.embedModel
    },
    entries
  };

  await saveIndex(account.id, index);
  await saveFolderStructure(account.id, folderPaths.map(path => ({
    path,
    name: path.split('/').pop(),
    selected: true
  })));

  browser.runtime.sendMessage({ type: 'training-complete' }).catch(() => {});

  return {
    success: true,
    messagesProcessed: processedMessages,
    foldersWithSamples,
    foldersTotal: folderPaths.length,
    samplesPerFolder
  };
}

async function getTrainedAccounts() {
  const data = await browser.storage.local.get(null);
  const ids = new Set();
  for (const key of Object.keys(data)) {
    if (key.startsWith('index_')) {
      ids.add(key.slice('index_'.length));
    }
  }
  return [...ids];
}

async function hasTrainedModel(accountId) {
  const data = await browser.storage.local.get(indexStorageKey(accountId));
  return !!data[indexStorageKey(accountId)];
}

async function deleteModel(accountId) {
  await deleteIndex(accountId);
  await browser.storage.local.remove(`folders_${accountId}`);
}

async function classifyMessages(accountId, messageIds) {
  const settings = await ollamaArchive.getOllamaSettings();
  await ollamaArchive.checkOllamaAvailable(settings);
  const index = await loadIndex(accountId);

  const ids = messageIds || [];
  const results = [];
  for (let i = 0; i < ids.length; i++) {
    const messageId = ids[i];
    if (!messageId) {
      results.push({
        messageId: null,
        folder: null,
        confidence: 0,
        error: 'Message has no id'
      });
      continue;
    }
    try {
      const prediction = await ollamaArchive.classifyMessageRagOnly(
        index,
        messageId,
        settings
      );
      results.push({ messageId, ...prediction, error: null });
    } catch (error) {
      results.push({
        messageId,
        folder: null,
        confidence: 0,
        error: error.message
      });
    }
    sendProgress({
      type: 'classification-progress',
      current: i + 1,
      total: ids.length
    });
  }
  return { results };
}

async function moveMessages(accountId, messages) {
  const results = [];
  for (const message of messages) {
    try {
      if (!message.predictedFolder) {
        throw new Error('No predicted folder for message');
      }
      const folders = await browser.folders.query({
        accountId,
        path: message.predictedFolder
      });
      if (!folders?.length) {
        throw new Error(`Target folder ${message.predictedFolder} not found`);
      }
      const targetFolderId = folders[0].id;
      try {
        await browser.messages.move([message.id], targetFolderId);
        results.push({ messageId: message.id, success: true, copied: false, count: 1 });
      } catch (moveError) {
        console.warn('Move failed, attempting copy:', moveError);
        await browser.messages.copy([message.id], targetFolderId);
        results.push({ messageId: message.id, success: true, copied: true, count: 1 });
      }
    } catch (error) {
      results.push({
        messageId: message.id,
        success: false,
        error: error.message,
        count: 1
      });
    }
  }
  return results;
}

async function getSavedFolders(accountId) {
  return loadFolderStructure(accountId);
}

function isUserFolder(folder) {
  return !isDefaultFolder(folder);
}

async function checkOllamaStatus() {
  try {
    const settings = await ollamaArchive.getOllamaSettings();
    await ollamaArchive.checkOllamaAvailable(settings);
    return { ok: true, settings };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function listOllamaModelsForPicker() {
  const settings = await ollamaArchive.getOllamaSettings();
  const all = await ollamaArchive.listOllamaModels(settings);
  const embedModels = all.filter(name => ollamaArchive.isEmbedModelName(name));
  const chatModels = all.filter(name => !ollamaArchive.isEmbedModelName(name));
  return {
    settings,
    chatModels: chatModels.length ? chatModels : all,
    embedModels: embedModels.length ? embedModels : all
  };
}

async function saveOllamaSettingsFromPicker(partial) {
  const settings = await ollamaArchive.saveOllamaSettings(partial);
  const validateModels = partial.chatModel || partial.embedModel;
  if (!validateModels) {
    return { ok: true, settings };
  }
  try {
    await ollamaArchive.checkOllamaAvailable(settings);
    return { ok: true, settings };
  } catch (error) {
    return { ok: false, settings, error: error.message };
  }
}

async function testOllamaConnectionForPicker(baseUrl) {
  const settings = await ollamaArchive.saveOllamaSettings({
    baseUrl: baseUrl.replace(/\/$/, '')
  });
  try {
    const result = await ollamaArchive.testOllamaConnection(settings);
    return { ok: true, settings, ...result };
  } catch (error) {
    return { ok: false, settings, error: error.message };
  }
}

async function handleBackgroundMessage(message) {
  switch (message.action) {
    case 'checkOllamaStatus':
      return checkOllamaStatus();
    case 'getOllamaSettings':
      return ollamaArchive.getOllamaSettings();
    case 'listOllamaModels':
      return listOllamaModelsForPicker();
    case 'saveOllamaSettings':
      return saveOllamaSettingsFromPicker(message.settings);
    case 'testOllamaConnection':
      return testOllamaConnectionForPicker(message.baseUrl);
    case 'getTrainedAccounts':
      return getTrainedAccounts();
    case 'deleteModel':
      await deleteModel(message.accountId);
      return { ok: true };
    case 'getFoldersWithState':
      return getFoldersWithState(message.account);
    case 'saveFolderStructure':
      await saveFolderStructure(message.accountId, message.folders);
      return { ok: true };
    case 'trainModel':
      return trainModel(message.account, message.selectedFolderPaths);
    case 'classifyMessages':
      return classifyMessages(message.accountId, message.messageIds);
    case 'moveMessages':
      return { results: await moveMessages(message.accountId, message.messages) };
    case 'hasTrainedModel':
      return hasTrainedModel(message.accountId);
    case 'openAssistant':
      await openAssistant();
      return { ok: true };
    case 'openSettings':
      await openSettings();
      return { ok: true };
    case 'getFolderPickerContext':
      return getFolderPickerContext();
    case 'listRankedFolders':
      return listRankedFolders(message.accountId, message.messageId);
    case 'refreshFolderPickerAfterMove':
      return refreshFolderPickerAfterMove(message.movedMessageIds);
    case 'learnAndMoveToFolder':
      return learnAndMoveMessages(
        message.accountId,
        message.messageIds,
        message.folderPath,
        false
      );
    default:
      throw new Error(`Unknown action: ${message.action}`);
  }
}

browser.runtime.onMessage.addListener((message) => {
  if (!message?.action) {
    return undefined;
  }
  return handleBackgroundMessage(message).catch(error => ({ error: error.message }));
});
