const MENU_ID = 'email-archive-assistant';
const MENU_MOVE_TO_PARENT = 'email-archive-move-to';
const MENU_FILTER_FOLDERS = 'email-archive-filter-folders';
const FOLDER_MENU_PREFIX = 'email-archive-f-';
const MAX_CONTEXT_MENU_FOLDERS = 25;

let learnFolderPathsForMenu = [];
let folderPickerPending = null;
const archiveFoldersCache = new Map();
const folderIdCache = new Map();
const pickerPreloadCache = new Map();
const pickerPreloadInFlight = new Set();
const inboxOrderCache = new Map();
const PICKER_PRELOAD_TTL_MS = 180000;
const INBOX_ORDER_CACHE_TTL_MS = 300000;
const PICKER_PRELOAD_WAIT_MS = 5000;

function invalidateArchiveFoldersCache(accountId) {
  if (accountId) {
    archiveFoldersCache.delete(accountId);
  } else {
    archiveFoldersCache.clear();
  }
}

async function resolveFolderId(accountId, folderPath) {
  const key = `${accountId}|${folderPath}`;
  if (folderIdCache.has(key)) {
    return folderIdCache.get(key);
  }
  const folders = await browser.folders.query({ accountId, path: folderPath });
  if (!folders?.length) {
    throw new Error(`Target folder ${folderPath} not found`);
  }
  folderIdCache.set(key, folders[0].id);
  return folders[0].id;
}

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
  const cached = archiveFoldersCache.get(accountId);
  if (cached && Date.now() - cached.at < 120000) {
    return cached.folders;
  }
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
  const folders = sorted.map(path => ({ path, score: 0 }));
  archiveFoldersCache.set(accountId, { folders, at: Date.now() });
  return folders;
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
    const settings = await llamaArchive.getLlamaSettings();
    await llamaArchive.checkLlamaEmbedAvailable(settings);
    const index = await loadIndex(accountId);
    const ranked = await llamaArchive.rankFoldersForMessage(
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
    const settings = await llamaArchive.getLlamaSettings();
    return {
      version: 1,
      accountId,
      updatedAt: Date.now(),
      settings: {
        embedModel: settings.embedModel
      },
      entries: []
    };
  }
}

async function addLearnedEntry(index, messageId, folderPath, settings) {
  const cached = llamaArchive.getMessageEmbeddingCache(messageId);
  let content;
  let embedding;
  if (cached) {
    content = cached.content;
    embedding = cached.embedding;
  } else {
    content = await llamaArchive.getMessageContent(
      messageId,
      settings.bodyPreviewLength
    );
    const embedText = llamaArchive.buildEmbedText({
      author: content.author,
      recipients: content.recipients,
      subject: content.subject,
      bodyPreview: content.bodyPreview
    });
    embedding = await llamaArchive.embedText(embedText, settings);
  }
  index.entries = index.entries.filter(entry => entry.messageId !== messageId);
  index.entries.push({
    messageId,
    folderPath,
    author: content.author,
    recipients: content.recipients,
    subject: content.subject,
    bodyPreview: content.bodyPreview,
    embedding
  });
  trimLearnedEntriesForFolder(index, folderPath, settings.maxSamplesPerFolder);
}

function trimLearnedEntriesForFolder(index, folderPath, maxPerFolder) {
  const cap = parseInt(maxPerFolder, 10);
  if (!Number.isFinite(cap) || cap < 1) {
    return;
  }
  const folderEntries = index.entries.filter(entry => entry.folderPath === folderPath);
  if (folderEntries.length <= cap) {
    return;
  }
  const dropCount = folderEntries.length - cap;
  const dropIds = new Set(folderEntries.slice(0, dropCount).map(entry => entry.messageId));
  index.entries = index.entries.filter(entry => !dropIds.has(entry.messageId));
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

async function updateIndexFromMoves(accountId, messageIds, folderPath) {
  if (!messageIds.length) {
    return;
  }
  const settings = await llamaArchive.getLlamaSettings();
  await llamaArchive.checkLlamaEmbedAvailable(settings);
  let index = await ensureIndex(accountId);
  for (const messageId of messageIds) {
    await addLearnedEntry(index, messageId, folderPath, settings);
  }
  index.updatedAt = Date.now();
  await saveIndex(accountId, index);
}

async function learnAndMoveMessages(accountId, messageIds, folderPath, notify = true, options = {}) {
  const { backgroundLearn = false } = options;
  if (!accountId || !folderPath || !messageIds?.length) {
    throw new Error('No message or folder selected.');
  }

  const moveResults = await moveMessages(
    accountId,
    messageIds.map(id => ({ id, predictedFolder: folderPath }))
  );
  const movedIds = moveResults.filter(result => result.success).map(result => result.messageId);
  const moved = movedIds.length;

  const learnTask = () => updateIndexFromMoves(accountId, movedIds, folderPath);
  if (backgroundLearn) {
    learnTask().catch(error => {
      console.error('Background index update failed:', error);
    });
  } else {
    await learnTask();
  }

  const folderName = folderPath.split('/').pop() || folderPath;
  let summary;
  if (moved === messageIds.length) {
    summary = backgroundLearn
      ? `Moved ${moved} message(s) to ${folderName}.`
      : `Moved ${moved} message(s) to ${folderName} and updated the index.`;
  } else {
    summary = `Moved ${moved} of ${messageIds.length} to ${folderName}.`;
  }
  if (notify) {
    await notifyUser(summary);
  }
  return { moved, learned: moved, total: messageIds.length, summary };
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

async function buildPickerStateForMessages(accountId, messages) {
  const folders = await getFoldersForContextMenu(accountId, messages);
  const ranked = folders.some(f => (Number(f.score) || 0) > 0);
  const rankingError = folders.find(f => f.rankingError)?.rankingError || null;
  return {
    close: false,
    accountId,
    messageIds: messages.map(m => m.id),
    folders,
    ranked,
    rankingError
  };
}

async function getInboxMessageIds(accountId) {
  const cached = inboxOrderCache.get(accountId);
  if (cached && Date.now() - cached.at < INBOX_ORDER_CACHE_TTL_MS) {
    return cached.ids;
  }
  const folders = await browser.folders.query({
    accountId,
    specialUse: ['inbox']
  });
  if (!folders?.length) {
    return [];
  }
  const ids = [];
  let page = await browser.messages.list(folders[0].id);
  while (page) {
    for (const msg of page.messages || []) {
      ids.push(msg.id);
    }
    page = page.id ? await browser.messages.continueList(page.id) : null;
  }
  inboxOrderCache.set(accountId, { ids, at: Date.now() });
  return ids;
}

function removeMessagesFromInboxOrderCache(accountId, messageIds) {
  const cached = inboxOrderCache.get(accountId);
  if (!cached) {
    return;
  }
  const moved = new Set(messageIds);
  cached.ids = cached.ids.filter(id => !moved.has(id));
}

function resolveNextInboxMessageId(accountId, currentMessageId) {
  const cached = inboxOrderCache.get(accountId);
  if (!cached?.ids?.length || !currentMessageId) {
    return null;
  }
  const idx = cached.ids.indexOf(currentMessageId);
  if (idx < 0 || idx >= cached.ids.length - 1) {
    return null;
  }
  return cached.ids[idx + 1];
}

async function guessNextInboxMessageId(accountId, currentMessageId) {
  await getInboxMessageIds(accountId);
  return resolveNextInboxMessageId(accountId, currentMessageId);
}

async function resolveNextInboxMessageIdAfterMove(accountId, movedMessageId, movedMessageIds) {
  await getInboxMessageIds(accountId);
  const nextId = resolveNextInboxMessageId(accountId, movedMessageId);
  removeMessagesFromInboxOrderCache(accountId, movedMessageIds);
  return nextId;
}

async function buildQuickPickerState(accountId, messageId) {
  const folders = await getSelectableArchiveFolders(accountId);
  const paths = folders.map(f => f.path);
  return {
    close: false,
    accountId,
    messageIds: [messageId],
    folders: sortFoldersByScore(paths.map(path => ({
      path,
      score: 0,
      title: formatFolderMenuTitle(path, paths, 0)
    }))),
    ranked: false,
    rankingError: null
  };
}

function rankAndNotifyPicker(accountId, messageId) {
  (async () => {
    try {
      const state = await buildPickerStateForMessages(accountId, [{ id: messageId }]);
      pickerPreloadCache.set(messageId, { state, at: Date.now() });
      schedulePickerPreload(accountId, messageId);
      await browser.runtime.sendMessage({
        type: 'picker-state-update',
        state
      });
    } catch (error) {
      console.warn('Picker rank update failed:', error);
    }
  })();
}

async function waitForPickerPreload(messageId, maxMs = PICKER_PRELOAD_WAIT_MS) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const entry = pickerPreloadCache.get(messageId);
    if (entry && Date.now() - entry.at < PICKER_PRELOAD_TTL_MS) {
      pickerPreloadCache.delete(messageId);
      return entry.state;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return null;
}

function takePreloadedPickerState(messageId) {
  const entry = pickerPreloadCache.get(messageId);
  if (!entry) {
    return null;
  }
  pickerPreloadCache.delete(messageId);
  if (Date.now() - entry.at > PICKER_PRELOAD_TTL_MS) {
    return null;
  }
  return entry.state;
}

function schedulePickerPreload(accountId, currentMessageId) {
  if (!accountId || !currentMessageId) {
    return;
  }
  const flightKey = `${accountId}:${currentMessageId}`;
  if (pickerPreloadInFlight.has(flightKey)) {
    return;
  }
  pickerPreloadInFlight.add(flightKey);
  (async () => {
    try {
      const nextId = await guessNextInboxMessageId(accountId, currentMessageId);
      if (!nextId) {
        return;
      }
      const cached = pickerPreloadCache.get(nextId);
      if (cached && Date.now() - cached.at < PICKER_PRELOAD_TTL_MS) {
        return;
      }
      const state = await buildPickerStateForMessages(accountId, [{ id: nextId }]);
      pickerPreloadCache.set(nextId, { state, at: Date.now() });
    } catch (error) {
      console.warn('Picker preload failed:', error);
    } finally {
      pickerPreloadInFlight.delete(flightKey);
    }
  })();
}

const FOLDER_PICKER_ADVANCE_MS = 40;

async function getFolderPickerInitialState() {
  const ctx = await getFolderPickerContext();
  void getInboxMessageIds(ctx.accountId);
  const rankedState = await listRankedFolders(ctx.accountId, ctx.messageIds[0]);
  schedulePickerPreload(ctx.accountId, ctx.messageIds[0]);
  return {
    accountId: ctx.accountId,
    messageIds: ctx.messageIds,
    folders: rankedState.folders,
    ranked: rankedState.ranked,
    rankingError: rankedState.rankingError
  };
}

async function refreshFolderPickerAfterMove(movedMessageIds, accountId, previousMessageId) {
  const moved = movedMessageIds || [];
  const movedSet = new Set(moved);
  for (const movedId of movedSet) {
    pickerPreloadCache.delete(movedId);
  }

  if (accountId && previousMessageId) {
    const nextId = await resolveNextInboxMessageIdAfterMove(
      accountId,
      previousMessageId,
      moved
    );
    if (!nextId) {
      return { close: true };
    }

    let state = takePreloadedPickerState(nextId);
    if (!state) {
      state = await waitForPickerPreload(nextId, 200);
    }
    if (state) {
      schedulePickerPreload(accountId, nextId);
      return state;
    }

    rankAndNotifyPicker(accountId, nextId);
    schedulePickerPreload(accountId, nextId);
    return buildQuickPickerState(accountId, nextId);
  }

  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt > 0) {
      await new Promise(resolve => setTimeout(resolve, FOLDER_PICKER_ADVANCE_MS));
    }
    const displayed = await browser.messageDisplay.getDisplayedMessages();
    const messages = messagesFromList(displayed);
    if (!messages.length) {
      return { close: true };
    }
    const nextMessages = messages.filter(m => !movedSet.has(m.id));
    if (!nextMessages.length) {
      continue;
    }
    const resolvedAccountId = await accountIdFromMessageHeader(nextMessages[0]);
    const nextId = nextMessages[0].id;
    let state = takePreloadedPickerState(nextId);
    if (!state) {
      state = await waitForPickerPreload(nextId, 500);
    }
    if (state) {
      schedulePickerPreload(resolvedAccountId, nextId);
      return state;
    }
    rankAndNotifyPicker(resolvedAccountId, nextId);
    schedulePickerPreload(resolvedAccountId, nextId);
    return buildQuickPickerState(resolvedAccountId, nextId);
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
  await Promise.all(menuFolders.map((folder, i) =>
    browser.menus.create({
      id: `${FOLDER_MENU_PREFIX}${i}`,
      parentId: MENU_MOVE_TO_PARENT,
      title: folder.title,
      contexts: ['message_list']
    })
  ));

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
  invalidateArchiveFoldersCache(accountId);
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
    invalidateArchiveFoldersCache(accountId);
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
  const settings = await llamaArchive.getLlamaSettings();
  await llamaArchive.checkLlamaEmbedAvailable(settings);

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
        const content = await llamaArchive.getMessageContent(
          message.id,
          settings.bodyPreviewLength
        );
        const embedText = llamaArchive.buildEmbedText({
          author: content.author,
          recipients: content.recipients,
          subject: content.subject,
          bodyPreview: content.bodyPreview
        });
        const embedding = await llamaArchive.embedText(embedText, settings);
        entries.push({
          messageId: message.id,
          folderPath,
          author: content.author,
          recipients: content.recipients,
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

async function trainAllAccounts() {
  const settings = await llamaArchive.getLlamaSettings();
  await llamaArchive.checkLlamaEmbedAvailable(settings);

  const accounts = await browser.accounts.list();
  const summary = [];

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    const folders = await getFoldersWithState(account);
    const selectedPaths = folders.filter(f => f.selected).map(f => f.path);

    sendProgress({
      type: 'training-account-start',
      accountName: account.name,
      accountIndex: i + 1,
      accountTotal: accounts.length
    });

    if (!selectedPaths.length) {
      summary.push({
        accountId: account.id,
        accountName: account.name,
        skipped: true,
        reason: 'No folders selected'
      });
      continue;
    }

    try {
      const result = await trainModel(account, selectedPaths);
      summary.push({
        accountId: account.id,
        accountName: account.name,
        skipped: false,
        ...result
      });
    } catch (error) {
      summary.push({
        accountId: account.id,
        accountName: account.name,
        skipped: false,
        success: false,
        error: error.message
      });
    }
  }

  browser.runtime.sendMessage({ type: 'training-complete' }).catch(() => {});

  const trained = summary.filter(r => r.success);
  const failed = summary.filter(r => !r.skipped && !r.success);
  const skipped = summary.filter(r => r.skipped);

  return {
    success: failed.length === 0,
    accountsTotal: accounts.length,
    trainedCount: trained.length,
    failedCount: failed.length,
    skippedCount: skipped.length,
    results: summary
  };
}

async function listInboxMessages(accountIds) {
  const ids = [...new Set((accountIds || []).filter(Boolean))];
  if (!ids.length) {
    return { messages: [] };
  }

  const accounts = await browser.accounts.list();
  const nameById = new Map(accounts.map(a => [a.id, a.name]));
  const messages = [];

  for (const accountId of ids) {
    const folders = await browser.folders.query({
      accountId,
      specialUse: ['inbox']
    });
    if (!folders?.length) {
      continue;
    }
    let page = await browser.messages.list(folders[0].id);
    while (page) {
      for (const msg of page.messages || []) {
        messages.push({
          id: msg.id,
          author: msg.author,
          subject: msg.subject,
          date: msg.date,
          accountId,
          accountName: nameById.get(accountId) || accountId
        });
      }
      page = page.id ? await browser.messages.continueList(page.id) : null;
    }
  }

  return { messages };
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
  const settings = await llamaArchive.getLlamaSettings();
  await llamaArchive.checkLlamaEmbedAvailable(settings);
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
      const prediction = await llamaArchive.classifyMessageRagOnly(
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
      const targetFolderId = await resolveFolderId(accountId, message.predictedFolder);
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

async function checkLlamaStatus() {
  try {
    const settings = await llamaArchive.getLlamaSettings();
    await llamaArchive.checkLlamaEmbedAvailable(settings);
    return { ok: true, settings };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function listLlamaModelsForPicker() {
  const settings = await llamaArchive.getLlamaSettings();
  const all = await llamaArchive.listLlamaModels(settings);
  const embedModels = all.filter(name => llamaArchive.isEmbedModelName(name));
  return {
    settings,
    embedModels: embedModels.length ? embedModels : all
  };
}

async function saveLlamaSettingsFromPicker(partial) {
  const settings = await llamaArchive.saveLlamaSettings(partial);
  if (!partial.embedModel) {
    return { ok: true, settings };
  }
  try {
    await llamaArchive.checkLlamaEmbedAvailable(settings);
    return { ok: true, settings };
  } catch (error) {
    return { ok: false, settings, error: error.message };
  }
}

async function testLlamaConnectionForPicker(embedBaseUrl) {
  const settings = await llamaArchive.saveLlamaSettings({
    embedBaseUrl: String(embedBaseUrl || '').replace(/\/$/, ''),
    baseUrl: String(embedBaseUrl || '').replace(/\/$/, '')
  });
  try {
    const result = await llamaArchive.testLlamaConnection(settings);
    return { ok: true, settings, ...result };
  } catch (error) {
    return { ok: false, settings, error: error.message };
  }
}

async function handleBackgroundMessage(message) {
  switch (message.action) {
    case 'checkLlamaStatus':
    case 'checkOllamaStatus':
      return checkLlamaStatus();
    case 'getLlamaSettings':
    case 'getOllamaSettings':
      return llamaArchive.getLlamaSettings();
    case 'listLlamaModels':
    case 'listOllamaModels':
      return listLlamaModelsForPicker();
    case 'saveLlamaSettings':
    case 'saveOllamaSettings':
      return saveLlamaSettingsFromPicker(message.settings);
    case 'testLlamaConnection':
    case 'testOllamaConnection':
      return testLlamaConnectionForPicker(message.embedBaseUrl || message.baseUrl);
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
    case 'trainAllAccounts':
      return trainAllAccounts();
    case 'listInboxMessages':
      return listInboxMessages(message.accountIds);
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
    case 'getFolderPickerInitialState':
      return getFolderPickerInitialState();
    case 'listRankedFolders':
      return listRankedFolders(message.accountId, message.messageId);
    case 'refreshFolderPickerAfterMove':
      return refreshFolderPickerAfterMove(
        message.movedMessageIds,
        message.accountId,
        message.previousMessageId
      );
    case 'preloadNextPickerState':
      schedulePickerPreload(message.accountId, message.currentMessageId);
      return { ok: true };
    case 'learnAndMoveToFolder':
      return learnAndMoveMessages(
        message.accountId,
        message.messageIds,
        message.folderPath,
        false,
        { backgroundLearn: message.backgroundLearn !== false }
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
