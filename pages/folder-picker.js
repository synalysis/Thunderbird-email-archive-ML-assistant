let allFolders = [];
let pickerContext = null;
let moving = false;
let selectedPath = null;
let currentFilterQuery = '';
let pickerRankingNote = null;
let pickerRankingIsError = false;

function folderMatchesFilter(folder, query) {
  if (!query) {
    return true;
  }
  const q = query.toLowerCase();
  const path = folder.path.toLowerCase();
  const title = (folder.title || '').toLowerCase();
  const leaf = (folder.path.split('/').pop() || folder.path).toLowerCase();
  return path.includes(q) || title.includes(q) || leaf.includes(q);
}

function sortFoldersByConfidence(folders) {
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

function formatFolderButtonLabel(folder) {
  if (folder.title) {
    return folder.title;
  }
  const score = Number(folder.score) || 0;
  const name = folder.path.split('/').pop() || folder.path;
  if (score > 0) {
    return `${Math.round(score * 100)}%  ${name}`;
  }
  return folder.path;
}

function defaultSelectedPath(folders) {
  if (!folders.length) {
    return null;
  }
  const best = folders[0];
  return (Number(best.score) || 0) > 0 ? best.path : null;
}

function syncSelectionToFiltered(filtered) {
  if (!filtered.length) {
    selectedPath = null;
    return;
  }
  if (!selectedPath || !filtered.some(f => f.path === selectedPath)) {
    selectedPath = defaultSelectedPath(filtered);
  }
}

function updateHint() {
  const hint = document.getElementById('messageHint');
  if (!pickerContext?.messageIds?.length) {
    return;
  }
  const count = pickerContext.messageIds.length;
  hint.textContent = count === 1
    ? 'Best match is preselected. Enter to move, or click a folder.'
    : `Best match is preselected. Enter to move ${count} messages, or click a folder.`;
}

function updateStatus(filtered, query) {
  const status = document.getElementById('status');
  if (pickerRankingNote && !query.trim()) {
    status.textContent = pickerRankingNote;
    status.className = pickerRankingIsError ? 'status error' : 'status';
    return;
  }
  if (!filtered.length) {
    status.textContent = query.trim()
      ? `${allFolders.length} folder(s) hidden by filter`
      : '';
    status.className = 'status';
    return;
  }
  const selected = filtered.find(f => f.path === selectedPath);
  const parts = [];
  if (query.trim() && filtered.length < allFolders.length) {
    parts.push(`Showing ${filtered.length} of ${allFolders.length}`);
  } else {
    parts.push(`${filtered.length} folder(s)`);
  }
  if (selected) {
    parts.push(`— Enter to move to “${selected.title || selected.path}”`);
  }
  status.textContent = parts.join(' ');
  status.className = 'status';
}

function updateSelectionHighlight() {
  const buttons = document.querySelectorAll('#folderList button[data-path]');
  buttons.forEach(btn => {
    const isSelected = btn.dataset.path === selectedPath;
    btn.classList.toggle('selected', isSelected);
    btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
  });
  const selectedBtn = document.querySelector('#folderList button.selected');
  selectedBtn?.scrollIntoView({ block: 'nearest' });
}

function renderFolderList(query = '') {
  currentFilterQuery = query;
  const listEl = document.getElementById('folderList');
  const filtered = allFolders.filter(f => folderMatchesFilter(f, query.trim()));
  syncSelectionToFiltered(filtered);

  listEl.innerHTML = '';
  if (filtered.length === 0) {
    const li = document.createElement('li');
    li.textContent = query.trim()
      ? 'No folders match your filter.'
      : 'No archive folders available.';
    li.style.padding = '10px';
    li.style.color = '#666';
    listEl.appendChild(li);
    updateStatus(filtered, query);
    return;
  }

  for (const folder of filtered) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.path = folder.path;
    btn.textContent = formatFolderButtonLabel(folder);
    btn.title = folder.path;
    if (folder.path === selectedPath) {
      btn.classList.add('selected');
      btn.setAttribute('aria-selected', 'true');
    }
    li.appendChild(btn);
    listEl.appendChild(li);
  }

  updateStatus(filtered, query);
}

function applyPickerState(state) {
  pickerContext = {
    accountId: state.accountId,
    messageIds: state.messageIds
  };
  allFolders = sortFoldersByConfidence(state.folders || []);
  selectedPath = defaultSelectedPath(allFolders);
  const hasScores = allFolders.some(f => (Number(f.score) || 0) > 0);
  if (state.rankingError) {
    pickerRankingNote = state.rankingError;
    pickerRankingIsError = true;
  } else if (state.ranked === false || !hasScores) {
    pickerRankingNote = allFolders.length
      ? 'Folders are alphabetical — no match scores (train the index or check Ollama).'
      : null;
    pickerRankingIsError = false;
  } else {
    pickerRankingNote = null;
    pickerRankingIsError = false;
  }
  const filterInput = document.getElementById('folderFilter');
  filterInput.value = '';
  currentFilterQuery = '';
  renderFolderList('');
  updateHint();
}

async function reloadForNextDisplayedMessage(movedMessageIds) {
  const status = document.getElementById('status');
  const filterInput = document.getElementById('folderFilter');
  status.textContent = 'Loading next message…';
  status.className = 'status';

  try {
    const state = await emailArchiveRequest('refreshFolderPickerAfterMove', {
      movedMessageIds
    });
    if (state.close) {
      window.close();
      return;
    }
    applyPickerState(state);
    status.textContent = 'Ready for the current message.';
    status.className = 'status';
    filterInput.disabled = false;
    filterInput.focus();
    moving = false;
  } catch (_) {
    window.close();
  }
}

async function moveToFolder(folderPath) {
  if (moving || !pickerContext) {
    return;
  }
  moving = true;
  const status = document.getElementById('status');
  const filterInput = document.getElementById('folderFilter');
  const movedMessageIds = [...pickerContext.messageIds];
  status.textContent = 'Moving…';
  status.className = 'status';
  filterInput.disabled = true;

  try {
    const result = await emailArchiveRequest('learnAndMoveToFolder', {
      accountId: pickerContext.accountId,
      messageIds: movedMessageIds,
      folderPath
    });
    status.textContent = result.summary || 'Moved.';
    status.className = 'status success';
    await reloadForNextDisplayedMessage(movedMessageIds);
  } catch (error) {
    status.textContent = error.message;
    status.className = 'status error';
    filterInput.disabled = false;
    moving = false;
  }
}

function moveToSelected() {
  if (selectedPath) {
    moveToFolder(selectedPath);
  }
}

function moveSelectionInList(delta) {
  const filtered = allFolders.filter(f =>
    folderMatchesFilter(f, currentFilterQuery.trim())
  );
  if (!filtered.length) {
    return;
  }
  let index = filtered.findIndex(f => f.path === selectedPath);
  if (index < 0) {
    index = 0;
  } else {
    index = Math.max(0, Math.min(filtered.length - 1, index + delta));
  }
  selectedPath = filtered[index].path;
  updateSelectionHighlight();
  updateStatus(filtered, currentFilterQuery);
  document.querySelector('#folderList button.selected')?.focus();
}

async function loadInitialPicker() {
  const filterInput = document.getElementById('folderFilter');
  const status = document.getElementById('status');

  status.textContent = 'Loading folders…';
  pickerContext = await emailArchiveRequest('getFolderPickerContext');
  const rankedState = await emailArchiveRequest('listRankedFolders', {
    accountId: pickerContext.accountId,
    messageId: pickerContext.messageIds[0]
  });
  applyPickerState({
    accountId: pickerContext.accountId,
    messageIds: pickerContext.messageIds,
    folders: rankedState.folders,
    ranked: rankedState.ranked,
    rankingError: rankedState.rankingError
  });
  filterInput.focus();
}

document.addEventListener('DOMContentLoaded', async () => {
  const filterInput = document.getElementById('folderFilter');
  const status = document.getElementById('status');
  const listEl = document.getElementById('folderList');

  listEl.addEventListener('click', event => {
    const btn = event.target.closest('button[data-path]');
    if (!btn || moving) {
      return;
    }
    selectedPath = btn.dataset.path;
    moveToFolder(selectedPath);
  });

  listEl.addEventListener('focusin', event => {
    const btn = event.target.closest('button[data-path]');
    if (!btn) {
      return;
    }
    selectedPath = btn.dataset.path;
    updateSelectionHighlight();
    const filtered = allFolders.filter(f =>
      folderMatchesFilter(f, currentFilterQuery.trim())
    );
    updateStatus(filtered, currentFilterQuery);
  });

  try {
    await loadInitialPicker();
  } catch (error) {
    status.textContent = error.message;
    status.className = 'status error';
    filterInput.disabled = true;
    setTimeout(() => window.close(), 1500);
  }

  filterInput.addEventListener('input', () => {
    renderFolderList(filterInput.value);
  });

  filterInput.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveSelectionInList(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelectionInList(-1);
    } else if (event.key === 'Enter' && selectedPath) {
      event.preventDefault();
      moveToSelected();
    }
  });

  document.addEventListener('keydown', event => {
    if (event.target === filterInput) {
      return;
    }
    if (event.key === 'Enter' && selectedPath) {
      event.preventDefault();
      moveToSelected();
    }
  });
});
