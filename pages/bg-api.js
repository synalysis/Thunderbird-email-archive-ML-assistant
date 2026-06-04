const ARRAY_RESULT_ACTIONS = new Set(['classifyMessages', 'moveMessages']);

async function emailArchiveRequest(action, payload = {}) {
  const response = await browser.runtime.sendMessage({ action, ...payload });
  if (response === undefined || response === null) {
    throw new Error(
      'No response from background. Reload the add-on, ensure Ollama is running, then try again.'
    );
  }
  if (response?.error) {
    throw new Error(response.error);
  }
  if (ARRAY_RESULT_ACTIONS.has(action)) {
    if (Array.isArray(response.results)) {
      return response.results;
    }
    if (Array.isArray(response)) {
      return response;
    }
    throw new Error(
      'Invalid response from background. Reload the add-on and try again.'
    );
  }
  return response;
}
