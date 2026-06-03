/**
 * aiosShell.js — shared modal shell + helpers for the native AIOS workforce views
 * (agentsRoster, org, proposals, brief, inbox, runsKanban, runTerminal).
 *
 * Factors out the tasks.js modal pattern (build .modal/.modal-content, close-btn,
 * Esc, click-outside, exit animation, optional poll) so each view module stays a
 * thin render function. Inherits the shared modal CSS + chat-area centering.
 */

export const API_BASE = window.location.origin;

/** HTML-escape a value for safe innerHTML interpolation. Encodes quotes too so
 *  it is safe in attribute context (e.g. data-name="${esc(...)}"). */
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** GET JSON from the same-origin AIOS proxy (/api/aios/...). Returns null on error. */
export async function aiosGet(path) {
  try {
    const res = await fetch(`${API_BASE}/api/aios${path}`, { credentials: 'same-origin' });
    return await res.json();
  } catch (e) {
    console.error('aios GET', path, 'failed', e);
    return null;
  }
}

/** POST JSON to the AIOS proxy. Returns parsed body (or {error}). */
export async function aiosPost(path, body) {
  try {
    const res = await fetch(`${API_BASE}/api/aios${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    });
    return await res.json();
  } catch (e) {
    console.error('aios POST', path, 'failed', e);
    return { error: String(e) };
  }
}

/** PATCH JSON to the AIOS proxy (issue lifecycle moves). Returns parsed body (or {error}). */
export async function aiosPatch(path, body) {
  try {
    const res = await fetch(`${API_BASE}/api/aios${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    });
    return await res.json();
  } catch (e) {
    console.error('aios PATCH', path, 'failed', e);
    return { error: String(e) };
  }
}

/**
 * Create a modal-backed view.
 *   id        — modal element id (also used in the style.css centering list).
 *   title     — header text.
 *   render    — async (bodyEl) => void. Called on open and on each poll tick.
 *   pollMs    — optional poll interval; re-invokes render while open.
 * Returns { open, close, isOpen }.
 */
export function createAiosModal({ id, title, render, pollMs }) {
  let _open = false;
  let _esc = null;
  let _poll = null;

  async function _tick() {
    const body = document.querySelector(`#${id} .modal-body`);
    if (body) {
      try { await render(body); } catch (e) { console.error(id, 'render failed', e); }
    }
  }

  function open() {
    if (_open) return;
    _open = true;
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = id;
    modal.innerHTML = `
      <div class="modal-content aios-modal-content">
        <div class="modal-header">
          <h4>${esc(title)}</h4>
          <span style="flex:1"></span>
          <button class="close-btn" id="${id}-close">✖</button>
        </div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:8px;overflow:auto;"></div>
      </div>`;
    document.body.appendChild(modal);
    document.getElementById(`${id}-close`).addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    _esc = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', _esc);

    const body = modal.querySelector('.modal-body');
    body.innerHTML = '<div style="opacity:0.6;padding:10px;">Loading…</div>';
    _tick();
    if (pollMs) _poll = setInterval(_tick, pollMs);
  }

  function close() {
    if (!_open) return;
    _open = false;
    const modal = document.getElementById(id);
    if (modal) {
      const content = modal.querySelector('.modal-content');
      if (content) {
        content.classList.add('modal-closing');
        content.addEventListener('animationend', () => modal.remove(), { once: true });
        setTimeout(() => { if (modal.parentElement) modal.remove(); }, 250);
      } else { modal.remove(); }
    }
    if (_esc) { document.removeEventListener('keydown', _esc); _esc = null; }
    if (_poll) { clearInterval(_poll); _poll = null; }
  }

  return { open, close, isOpen: () => _open };
}
