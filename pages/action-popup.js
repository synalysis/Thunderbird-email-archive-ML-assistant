const status = document.getElementById('status');

async function runAction(action) {
  status.textContent = '';
  status.className = '';
  try {
    await browser.runtime.sendMessage({ action });
    window.close();
  } catch (error) {
    status.textContent = error.message;
    status.className = 'error';
  }
}

document.getElementById('openAssistant').addEventListener('click', () => {
  runAction('openAssistant');
});
document.getElementById('openSettings').addEventListener('click', () => {
  runAction('openAssistant');
});
