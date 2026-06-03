/**
 * Egress Consent Module — the "Approve egress" wall (MIGRATION_PLAN §4, step 3).
 *
 * When the Overlord wants to send sensitive (already-scrubbed) content to a remote
 * model, the backend stages it in data/egress_pending.json. This modal shows diego
 * the EXACT scrubbed payload and records an explicit approve/reject via
 * POST /api/egress/consent. No content egresses without a yes here.
 *
 * Follows the tasks.js modal pattern (build .modal/.modal-content, close-btn, Esc,
 * click-outside) so it inherits the shared modal CSS + chat-area centering.
 */

const API_BASE = window.location.origin;

let _open = false;
let _escHandler = null;
let _pollInterval = null;
let _pending = null;

async function _fetchPending() {
  try {
    const res = await fetch(`${API_BASE}/api/egress/pending`, { credentials: 'same-origin' });
    const data = await res.json();
    _pending = data.pending || null;
  } catch (e) {
    console.error('egress: failed to fetch pending', e);
    _pending = null;
  }
  if (_open) _render();
}

async function _decide(approve) {
  if (!_pending || !_pending.request_id) return;
  try {
    await fetch(`${API_BASE}/api/egress/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ request_id: _pending.request_id, approve: !!approve }),
    });
  } catch (e) {
    console.error('egress: failed to submit consent', e);
  }
  _pending = null;
  _render();
}

function _render() {
  const body = document.querySelector('#egress-modal .modal-body');
  if (!body) return;
  if (!_pending) {
    body.innerHTML = `<div class="egress-empty" style="opacity:0.7;padding:12px;">
      No egress request is awaiting your approval.</div>`;
    return;
  }
  const reasons = (_pending.reasons || []).map(r => `<li>${_esc(r)}</li>`).join('');
  body.innerHTML = `
    <div class="egress-meta" style="font-size:12px;opacity:0.8;margin-bottom:8px;">
      Target: <strong>${_esc(_pending.target || 'remote')}</strong>
      &nbsp;·&nbsp; request <code>${_esc(_pending.request_id)}</code>
    </div>
    ${reasons ? `<div class="egress-reasons"><div style="font-size:12px;opacity:0.8;">Why this is gated:</div><ul>${reasons}</ul></div>` : ''}
    <div style="font-size:12px;opacity:0.8;margin:8px 0 4px;">Exact payload that will be sent (scrubbed):</div>
    <pre class="egress-payload" style="white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px;max-height:40vh;overflow:auto;">${_esc(_pending.scrubbed || '')}</pre>
    <div class="egress-actions" style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;">
      <button id="egress-reject" class="btn">Reject</button>
      <button id="egress-approve" class="btn" style="background:var(--accent, var(--green));color:var(--panel);">Approve egress</button>
    </div>`;
  body.querySelector('#egress-approve').addEventListener('click', () => _decide(true));
  body.querySelector('#egress-reject').addEventListener('click', () => _decide(false));
}

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function openEgressConsent() {
  if (_open) return;
  _open = true;

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.id = 'egress-modal';
  modal.innerHTML = `
    <div class="modal-content egress-modal-content">
      <div class="modal-header">
        <h4>Approve egress</h4>
        <span style="flex:1"></span>
        <button class="close-btn" id="egress-close">✖</button>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:6px;overflow:hidden;"></div>
    </div>`;
  document.body.appendChild(modal);

  document.getElementById('egress-close').addEventListener('click', closeEgressConsent);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeEgressConsent(); });
  _escHandler = (e) => { if (e.key === 'Escape') closeEgressConsent(); };
  document.addEventListener('keydown', _escHandler);

  _render();
  _fetchPending();
  if (!_pollInterval) _pollInterval = setInterval(_fetchPending, 5000);
}

export function closeEgressConsent() {
  if (!_open) return;
  _open = false;
  const modal = document.getElementById('egress-modal');
  if (modal) {
    const content = modal.querySelector('.modal-content');
    if (content) {
      content.classList.add('modal-closing');
      content.addEventListener('animationend', () => modal.remove(), { once: true });
      setTimeout(() => { if (modal.parentElement) modal.remove(); }, 250);
    } else {
      modal.remove();
    }
  }
  if (_escHandler) { document.removeEventListener('keydown', _escHandler); _escHandler = null; }
  if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; }
}

export function isEgressConsentOpen() { return _open; }

const egressConsentModule = { openEgressConsent, closeEgressConsent, isEgressConsentOpen };
export default egressConsentModule;
