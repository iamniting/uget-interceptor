'use strict';

const enabledEl = document.getElementById('enabled');
const statusDotEl = document.getElementById('status-dot');
const statusTextEl = document.getElementById('status-text');

function sendMessage(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

function setStatus(kind, text) {
  statusDotEl.className = `status-dot ${kind}`;
  statusTextEl.textContent = text;
}

function renderState(state) {
  const enabled = Boolean(state && state.enabled);
  enabledEl.checked = enabled;

  if (state && state.hostReachable === true) {
    setStatus('connected', 'Status: connected to uGet');
    return;
  }

  if (state && state.hostReachable === false) {
    setStatus('disconnected', 'Status: uGet not connected');
    return;
  }

  setStatus('checking', 'Status: checking connection...');
}

async function loadState() {
  const state = await sendMessage({ type: 'getState' });
  renderState(state || {});
  return state || {};
}

async function refreshConnection() {
  setStatus('checking', 'Status: checking connection...');
  await sendMessage({ type: 'checkHost' });
  return loadState();
}

enabledEl.addEventListener('change', async () => {
  setStatus('checking', 'Status: checking connection...');
  await sendMessage({ type: 'setEnabled', enabled: enabledEl.checked });
  await loadState();
});

refreshConnection();
