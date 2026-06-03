/**
 * proposals.js — native Hermes Proposals view, with full detail + approve/reject.
 * List:   GET /api/aios/proposals → {proposals:[{name,kind,mtime,size,preview}]}.
 * Detail: GET /api/aios/proposals/{name} → {name,kind,mtime,content}  (full markdown).
 * Tap a card to expand the FULL proposal (rendered markdown), not just the preview.
 * Actions: POST /api/aios/proposals/{name}/approve|reject (confirm first).
 */
import { createAiosModal, aiosGet, aiosPost, esc } from './aiosShell.js';
import { mdToHtml } from './markdown.js';

const _expanded = new Set();   // proposal names currently expanded
const _detail = {};            // name -> full markdown content (cache)

function _fmtDate(mtime) {
  if (!mtime) return '';
  const sec = Math.max(0, Math.floor(Date.now() / 1000 - mtime));
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}d ago`;
  try { return new Date(mtime * 1000).toISOString().slice(0, 10); } catch { return ''; }
}

async function _act(name, action) {
  const verb = action === 'approve' ? 'Approve' : 'Reject';
  if (!window.confirm(`${verb} proposal "${name}"?`)) return;
  const res = await aiosPost(`/proposals/${encodeURIComponent(name)}/${action}`, {});
  if (res && res.error) window.alert(`Failed: ${res.error}`);
  _expanded.delete(name);
  const body = document.querySelector('#aios-proposals-modal .modal-body');
  if (body) render(body);
}

async function _toggle(name) {
  if (_expanded.has(name)) {
    _expanded.delete(name);
  } else {
    _expanded.add(name);
    if (!_detail[name]) {
      const d = await aiosGet(`/proposals/${encodeURIComponent(name)}`);
      _detail[name] = (d && d.content) || '_Could not load this proposal._';
    }
  }
  const body = document.querySelector('#aios-proposals-modal .modal-body');
  if (body) render(body);
}

function _card(p) {
  const name = p.name || p.id || '(unnamed)';
  const open = _expanded.has(name);
  const kind = p.kind ? `<span class="aios-kind">${esc(p.kind)}</span>` : '';
  let detail = '';
  if (open) {
    const md = _detail[name];
    detail = md
      ? `<div class="aios-card-body"><div class="aios-md">${mdToHtml(md)}</div></div>`
      : '<div class="aios-card-body"><div class="aios-preview">Loading…</div></div>';
  } else if (p.preview || p.summary || p.description) {
    const prev = String(p.preview || p.summary || p.description).slice(0, 240).trim();
    detail = `<div class="aios-card-body"><div class="aios-preview">${esc(prev)}…</div></div>`;
  }
  return `<div class="aios-card ${open ? 'open' : ''}" data-name="${esc(name)}">
    <div class="aios-card-head" data-toggle="${esc(name)}">
      <span class="aios-chevron"></span>
      ${kind}
      <span class="aios-title">${esc(name)}</span>
      <span class="aios-meta">${esc(_fmtDate(p.mtime))}</span>
      <span style="flex:1"></span>
      <span class="aios-card-actions">
        <button class="aios-pill approve" data-act="approve" data-name="${esc(name)}">Approve</button>
        <button class="aios-pill reject" data-act="reject" data-name="${esc(name)}">Reject</button>
      </span>
    </div>
    ${detail}
  </div>`;
}

async function render(body) {
  const data = await aiosGet('/proposals');
  const props = (data && data.proposals) || [];
  if (!props.length) {
    body.innerHTML = '<div class="aios-empty">No pending proposals.<br><span style="opacity:0.7">Hermes advisory passes land here for review.</span></div>';
    return;
  }
  body.innerHTML = props.map(_card).join('');
  // Action buttons (don't toggle the card)
  body.querySelectorAll('.aios-pill').forEach((b) =>
    b.addEventListener('click', (e) => { e.stopPropagation(); _act(b.dataset.name, b.dataset.act); }));
  // Card head toggles the full-detail expansion
  body.querySelectorAll('.aios-card-head').forEach((h) =>
    h.addEventListener('click', () => _toggle(h.dataset.toggle)));
}

const modal = createAiosModal({ id: 'aios-proposals-modal', title: 'Proposals', render });
export const openProposals = modal.open;
export const closeProposals = modal.close;
export const isProposalsOpen = modal.isOpen;
export default { openProposals, closeProposals, isProposalsOpen };
