const status = document.getElementById('status');

document.getElementById('openAssistant').addEventListener('click', async () => {
  status.textContent = '';
  status.className = '';
  try {
    await browser.runtime.sendMessage({ action: 'openAssistant' });
    status.textContent = 'Assistant opened in a new tab.';
  } catch (error) {
    status.textContent = error.message;
    status.className = 'error';
  }
});
