document.addEventListener('DOMContentLoaded', () => {
  if (window.self !== window.top) {
    document.body.classList.add('embedded');
  }

  const tabs = document.querySelectorAll('.tab');
  const frames = document.querySelectorAll('iframe');
  const trainFrame = document.getElementById('training-frame');
  const archiveFrame = document.getElementById('archive-frame');

  // Relay background progress to iframes (avoid extra runtime.onMessage listeners there).
  browser.runtime.onMessage.addListener((message) => {
    if (message?.action) {
      return undefined;
    }
    if (!message?.type) {
      return undefined;
    }
    const trainingTypes = new Set([
      'training-progress',
      'training-complete',
      'training-account-start',
      'folder-sync-start',
      'folder-sync-complete'
    ]);
    if (trainingTypes.has(message.type)) {
      trainFrame?.contentWindow?.postMessage(message, '*');
    }
    if (message.type === 'classification-progress' || message.type === 'training-complete') {
      archiveFrame?.contentWindow?.postMessage(message, '*');
    }
    return undefined;
  });
  
  function switchTab(targetId) {
    // Hide all frames
    frames.forEach(frame => {
      frame.style.display = 'none';
    });
    
    // Remove active class from all tabs
    tabs.forEach(tab => {
      tab.classList.remove('active');
    });
    
    // Show selected frame and activate tab
    const selectedFrame = document.getElementById(targetId + '-frame');
    const selectedTab = document.querySelector(`[data-target="${targetId}"]`);
    
    if (selectedFrame && selectedTab) {
      selectedFrame.style.display = 'block';
      selectedTab.classList.add('active');
    }
  }
  
  // Add click handlers to tabs
  tabs.forEach(tab => {
    tab.addEventListener('click', (e) => {
      const targetId = tab.dataset.target;
      switchTab(targetId);
    });
  });
  
  // Show first tab by default
  if (tabs.length > 0) {
    switchTab(tabs[0].dataset.target);
  }
}); 