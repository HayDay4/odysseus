/**
 * proposals.js — native Hermes Proposals view, approve/reject (MIGRATION_PLAN §7).
 * Source: GET /api/aios/proposals → {proposals:[...]}.
 * Actions: POST /api/aios/proposals/{name}/approve|reject (confirm dialog first).
 */
import { createAiosModal, aiosGet, aiosPost, esc } from './aiosShell.js';

async function _act(name, action) {
  const verb = action === 'approve' ? 'Approve' : 'Reject';
  if (!window.confirm(`${verb} proposal "${name}"?`)) return;
  const res = await aiosPost(`/proposals/${encodeURIComponent(name)}/${action}`, {});
  if (res && res.error) window.alert(`Failed: ${res.error}`);
  const body = document.querySelector('#aios-proposals-modal .modal-body');
  if (body) render(body);
}

function _card(p) {
  const name = p.name || p.id || '(unnamed)';
  const kind = p.kind ? `<span style="font-size:11px;opacity:0.6;">${esc(p.kind)}</span>` : '';
  const preview = p.preview || p.summary || p.description || '';
  return `<div class="proposal-card" data-name="${esc(name)}"
       style="border:1px solid var(--border);border-radius:6px;padding:10px;">
    <div style="display:flex;align-items:center;gap:8px;">
      <strong>${esc(name)}</strong> ${kind}
      <span style="flex:1"></span>
      <button class="btn prop-approve" data-name="${esc(name)}">Approve</button>
      <button class="btn prop-reject" data-name="${esc(name)}">Reject</button>
    </div>
    ${preview ? `<div style="font-size:12px;opacity:0.75;margin-top:6px;white-space:pre-wrap;">${esc(String(preview).slice(0, 600))}</div>` : ''}
  </div>`;
}

async function render(body) {
  const data = await aiosGet('/proposals');
  const props = (data && data.proposals) || [];
  if (!props.length) {
    body.innerHTML = '<div style="opacity:0.6;padding:10px;">No pending proposals.</div>';
    return;
  }
  body.innerHTML = props.map(_card).join('');
  body.querySelectorAll('.prop-approve').forEach((b) =>
    b.addEventListener('click', () => _act(b.dataset.name, 'approve')));
  body.querySelectorAll('.prop-reject').forEach((b) =>
    b.addEventListener('click', () => _act(b.dataset.name, 'reject')));
}

const modal = createAiosModal({ id: 'aios-proposals-modal', title: 'Proposals', render, pollMs: 5000 });
export const openProposals = modal.open;
export const closeProposals = modal.close;
export const isProposalsOpen = modal.isOpen;
export default { openProposals, closeProposals, isProposalsOpen };
