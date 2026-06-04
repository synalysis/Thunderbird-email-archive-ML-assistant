let currentAccount = null;
let messages = [];
let isClassifying = false;

// One embedding per message (RAG match, no LLM); small batches avoid sendMessage timeouts.
const CLASSIFY_BATCH_SIZE = 1;

function getConfidenceClass(confidence) {
  if (confidence >= 80) return 'confidence-high';
  if (confidence >= 50) return 'confidence-medium';
  return 'confidence-low';
}

function getConfidenceThreshold() {
  return parseInt(document.getElementById('confidenceSlider').value, 10);
}

function applyPredictionToRow(index, prediction, threshold) {
  const message = messages[index];
  message.predictedFolder = prediction.folder;
  message.confidence = prediction.confidence;

  const rows = document.getElementById('messageList').getElementsByTagName('tr');
  const row = rows[index];
  if (!row) return;

  const targetCell = row.querySelector('.target-folder');
  const confidenceCell = row.querySelector('.confidence-value');
  targetCell.textContent = prediction.folder || '';
  confidenceCell.textContent = prediction.confidence
    ? `${prediction.confidence.toFixed(1)}%`
    : '';
  confidenceCell.className = `col-confidence confidence-value ${getConfidenceClass(prediction.confidence)}`;

  if (prediction.confidence < threshold) {
    targetCell.classList.add('low-confidence');
  } else {
    targetCell.classList.remove('low-confidence');
  }
}

function sortMessages(field, ascending = true) {
  messages.sort((a, b) => {
    let aValue;
    let bValue;
    switch (field) {
      case 'from':
        aValue = (a.author || '').toLowerCase();
        bValue = (b.author || '').toLowerCase();
        break;
      case 'subject':
        aValue = (a.subject || '').toLowerCase();
        bValue = (b.subject || '').toLowerCase();
        break;
      case 'date':
        aValue = new Date(a.date);
        bValue = new Date(b.date);
        break;
      case 'target':
        aValue = (a.predictedFolder || '').toLowerCase();
        bValue = (b.predictedFolder || '').toLowerCase();
        break;
      case 'confidence':
        aValue = Number.isFinite(a.confidence) ? a.confidence : -1;
        bValue = Number.isFinite(b.confidence) ? b.confidence : -1;
        break;
      default:
        return 0;
    }
    if (aValue < bValue) return ascending ? -1 : 1;
    if (aValue > bValue) return ascending ? 1 : -1;
    return 0;
  });
  updateTable();
}

function updateTable() {
  const messageList = document.getElementById('messageList');
  const threshold = getConfidenceThreshold();
  messageList.innerHTML = '';

  messages.forEach((message, index) => {
    const row = document.createElement('tr');
    row.dataset.messageId = message.id;
    const confidenceClass = message.confidence
      ? getConfidenceClass(message.confidence)
      : '';
    const confidenceDisplay = message.confidence
      ? `${message.confidence.toFixed(1)}%`
      : '';
    const lowClass = message.confidence && message.confidence < threshold
      ? 'low-confidence'
      : '';

    row.innerHTML = `
      <td><input type="checkbox" data-index="${index}"></td>
      <td class="col-date">${new Date(message.date).toLocaleDateString()}</td>
      <td class="col-from">${escapeHtml(message.author || '')}</td>
      <td class="col-subject">${escapeHtml(message.subject || '')}</td>
      <td class="col-confidence confidence-value ${confidenceClass}">${confidenceDisplay}</td>
      <td class="col-target target-folder ${lowClass}">${escapeHtml(message.predictedFolder || '')}</td>
    `;
    messageList.appendChild(row);
  });

  messageList.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
    checkbox.addEventListener('change', updateActionButtons);
  });
  initializeColumnResizing();
  updateActionButtons();
}

async function classifyAllMessages() {
  if (!currentAccount || isClassifying) return;

  const status = document.getElementById('status');
  const archiveButton = document.getElementById('archiveConfidentButton');
  const reclassifyButton = document.getElementById('reclassifyButton');
  const threshold = getConfidenceThreshold();

  isClassifying = true;
  archiveButton.disabled = true;
  reclassifyButton.disabled = true;
  status.textContent = `Classifying 0 / ${messages.length}…`;
  status.className = '';

  try {
    let failed = 0;
    const total = messages.length;

    for (let start = 0; start < total; start += CLASSIFY_BATCH_SIZE) {
      const batch = messages.slice(start, start + CLASSIFY_BATCH_SIZE);
      const batchResults = await emailArchiveRequest('classifyMessages', {
        accountId: currentAccount.id,
        messageIds: batch.map(m => m.id)
      });

      batchResults.forEach((result, batchIndex) => {
        const index = start + batchIndex;
        if (result.error || !result.folder) {
          failed++;
          const rows = document.getElementById('messageList').getElementsByTagName('tr');
          const targetCell = rows[index]?.querySelector('.target-folder');
          if (targetCell) {
            targetCell.textContent = result.error ? 'Failed' : '';
            targetCell.classList.add('error');
          }
        } else {
          applyPredictionToRow(index, result, threshold);
        }
      });

      status.textContent =
        `Classifying ${Math.min(start + batch.length, total)} / ${total} (embedding match per message)…`;
    }

    status.textContent = failed
      ? `Classification done. ${failed} of ${total} failed (is Ollama running?).`
      : `Classification complete for ${total} message(s).`;
    status.className = failed ? 'warning' : 'success';
  } catch (error) {
    console.error('Classification error:', error);
    status.textContent = `Error: ${error.message}`;
    status.className = 'error';
  } finally {
    isClassifying = false;
    updateActionButtons();
  }
}

async function loadInboxMessages() {
  const messageList = document.getElementById('messageList');
  const status = document.getElementById('status');

  if (!currentAccount) {
    messageList.innerHTML = '<tr><td colspan="6">Please select an account</td></tr>';
    return;
  }

  try {
    status.textContent = 'Loading messages…';
    messages = [];

    const folders = await browser.folders.query({
      accountId: currentAccount.id,
      specialUse: ['inbox']
    });
    if (!folders?.length) throw new Error('Inbox folder not found');

    let page = await browser.messages.list(folders[0].id);
    while (page) {
      if (page.messages?.length) {
        messages.push(...page.messages);
      }
      page = page.id ? await browser.messages.continueList(page.id) : null;
    }

    if (messages.length === 0) {
      messageList.innerHTML = '<tr><td colspan="6">No messages in Inbox</td></tr>';
      status.textContent = 'Inbox is empty';
      status.className = 'warning';
      return;
    }

    updateTable();
    status.textContent =
      `Loaded ${messages.length} messages. Classifying by similarity to your index…`;
    await classifyAllMessages();
  } catch (error) {
    console.error('Error loading messages:', error);
    messageList.innerHTML = '<tr><td colspan="6">Error loading messages</td></tr>';
    status.textContent = `Error: ${error.message}`;
    status.className = 'error';
  }
}

function updateActionButtons() {
  const archiveButton = document.getElementById('archiveConfidentButton');
  const moveButton = document.getElementById('moveSelectedButton');
  const threshold = getConfidenceThreshold();
  const hasPredictions = messages.some(m => m.predictedFolder);
  const confidentCount = messages.filter(
    m => m.predictedFolder && m.confidence >= threshold
  ).length;
  const selectedClassified = document.querySelector(
    'input[type="checkbox"]:checked'
  ) && messages.some((m, i) => {
    const cb = document.querySelector(`input[data-index="${i}"]`);
    return cb?.checked && m.predictedFolder;
  });

  archiveButton.disabled = isClassifying || confidentCount === 0;
  moveButton.disabled = isClassifying || !selectedClassified;
}

function escapeHtml(unsafe) {
  return (unsafe || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function initializeColumnResizing() {
  const headers = document.querySelectorAll('table th');
  headers.forEach(header => {
    if (header.querySelector('.resizer')) return;
    const resizer = document.createElement('div');
    resizer.className = 'resizer';
    header.appendChild(resizer);
    let startX;
    let startWidth;

    resizer.addEventListener('pointerdown', e => {
      startX = e.pageX;
      startWidth = header.offsetWidth;
      resizer.setPointerCapture(e.pointerId);

      const onMove = ev => {
        if (ev.buttons === 0) return cleanup();
        header.style.width = `${startWidth + (ev.pageX - startX)}px`;
      };
      const cleanup = () => {
        resizer.removeEventListener('pointermove', onMove);
        resizer.removeEventListener('pointerup', cleanup);
        if (resizer.hasPointerCapture(e.pointerId)) {
          resizer.releasePointerCapture(e.pointerId);
        }
      };
      resizer.addEventListener('pointermove', onMove);
      resizer.addEventListener('pointerup', cleanup);
    });
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  const accountSelect = document.getElementById('accountSelect');
  const refreshButton = document.getElementById('refreshAccounts');
  const archiveButton = document.getElementById('archiveConfidentButton');
  const reclassifyButton = document.getElementById('reclassifyButton');
  const moveButton = document.getElementById('moveSelectedButton');
  const selectAll = document.getElementById('selectAll');
  const status = document.getElementById('status');
  const confidenceSlider = document.getElementById('confidenceSlider');
  const confidenceValue = document.getElementById('confidenceValue');
  const ollamaStatus = document.getElementById('ollamaStatus');

  async function updateOllamaStatus() {
    try {
      const stored = await emailArchiveRequest('getOllamaSettings');
      await fetchOllamaTags(stored.baseUrl);
      ollamaStatus.textContent = `Ollama: ${stored.chatModel} + ${stored.embedModel}`;
      ollamaStatus.className = 'ollama-status ok';
    } catch (error) {
      ollamaStatus.textContent = `Ollama: ${error.message}`;
      ollamaStatus.className = 'ollama-status error';
    }
  }

  async function loadAccounts() {
    try {
      refreshButton.disabled = true;
      refreshButton.textContent = '⌛';
      const accounts = await browser.accounts.list();
      const trainedAccounts = await emailArchiveRequest('getTrainedAccounts');

      accountSelect.innerHTML = '<option value="">Select Account</option>';
      for (const account of accounts) {
        if (trainedAccounts.includes(account.id)) {
          const option = document.createElement('option');
          option.value = account.id;
          option.textContent = account.name;
          accountSelect.appendChild(option);
        }
      }

      if (currentAccount && trainedAccounts.includes(currentAccount.id)) {
        accountSelect.value = currentAccount.id;
      } else {
        currentAccount = null;
        accountSelect.value = '';
      }
    } catch (error) {
      status.textContent = `Error loading accounts: ${error.message}`;
      status.className = 'error';
    } finally {
      refreshButton.disabled = false;
      refreshButton.textContent = '↻';
    }
  }

  await updateOllamaStatus();
  await loadAccounts();

  refreshButton.addEventListener('click', async () => {
    await loadAccounts();
    await updateOllamaStatus();
    status.textContent = 'Account list refreshed';
    status.className = 'success';
  });

  accountSelect.addEventListener('change', async () => {
    const accountId = accountSelect.value;
    if (!accountId) {
      currentAccount = null;
      return;
    }
    const accounts = await browser.accounts.list();
    currentAccount = accounts.find(a => a.id === accountId);
    if (!currentAccount) return;
    await loadInboxMessages();
  });

  selectAll.addEventListener('change', () => {
    document.querySelectorAll('#messageList input[type="checkbox"]').forEach(cb => {
      cb.checked = selectAll.checked;
    });
    updateActionButtons();
  });

  confidenceSlider.addEventListener('input', () => {
    confidenceValue.textContent = `${confidenceSlider.value}%`;
    updateTable();
  });

  document.querySelectorAll('th[data-sort]').forEach(header => {
    header.addEventListener('click', () => {
      const field = header.dataset.sort;
      const ascending = header.dataset.order !== 'asc';
      document.querySelectorAll('th[data-sort]').forEach(h => {
        h.dataset.order = h === header ? (ascending ? 'asc' : 'desc') : '';
      });
      sortMessages(field, ascending);
    });
  });

  archiveButton.addEventListener('click', async () => {
    if (!currentAccount) return;
    const threshold = getConfidenceThreshold();
    const toMove = messages.filter(
      m => m.predictedFolder && m.confidence >= threshold
    );
    if (toMove.length === 0) {
      status.textContent = 'No messages meet the confidence threshold.';
      status.className = 'warning';
      return;
    }

    archiveButton.disabled = true;
    status.textContent = `Archiving ${toMove.length} message(s)…`;
    try {
      const results = await emailArchiveRequest('moveMessages', {
        accountId: currentAccount.id,
        messages: toMove.map(m => ({
          id: m.id,
          predictedFolder: m.predictedFolder
        }))
      });
      const successCount = results.filter(r => r.success).length;
      const failCount = results.length - successCount;
      await loadInboxMessages();
      status.textContent = failCount
        ? `Archived ${successCount}. ${failCount} failed.`
        : `Archived ${successCount} message(s).`;
      status.className = failCount ? 'warning' : 'success';
    } catch (error) {
      status.textContent = `Error: ${error.message}`;
      status.className = 'error';
      archiveButton.disabled = false;
    }
  });

  reclassifyButton.addEventListener('click', classifyAllMessages);

  moveButton.addEventListener('click', async () => {
    if (!currentAccount) return;
    const threshold = getConfidenceThreshold();
    const checkboxes = document.querySelectorAll('#messageList input[type="checkbox"]');
    const selectedMessages = [];
    checkboxes.forEach((checkbox, index) => {
      if (checkbox.checked && messages[index]?.predictedFolder
          && messages[index].confidence >= threshold) {
        selectedMessages.push(messages[index]);
      }
    });

    if (selectedMessages.length === 0) {
      status.textContent = 'Select classified messages above the confidence threshold.';
      status.className = 'warning';
      return;
    }

    moveButton.disabled = true;
    try {
      await emailArchiveRequest('moveMessages', {
        accountId: currentAccount.id,
        messages: selectedMessages.map(m => ({
          id: m.id,
          predictedFolder: m.predictedFolder
        }))
      });
      await loadInboxMessages();
      status.textContent = `Moved ${selectedMessages.length} selected message(s).`;
      status.className = 'success';
    } catch (error) {
      status.textContent = `Error: ${error.message}`;
      status.className = 'error';
    } finally {
      updateActionButtons();
    }
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) {
      return;
    }
    const message = event.data;
    if (message.type === 'classification-progress') {
      status.textContent = `Classifying ${message.current} / ${message.total}…`;
    } else if (message.type === 'training-complete') {
      loadAccounts();
    }
  });

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      await loadAccounts();
      await updateOllamaStatus();
    }
  });
});
