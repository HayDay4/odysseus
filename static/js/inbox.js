/**
 * inbox.js — native Inbox drilldown (MIGRATION_PLAN §7).
 * Source: GET /api/aios/inbox → {items:[...]} (join-heavy backend; show a spinner).
 * Renders defensively — item shape varies (review items enriched with advisory).
 */
import { createAiosModal, aiosGet, esc } from './aiosShell.js';

function _item(it) {
  const title = it.title || it.subject || it.kind || it.id || '(item)';
  const kind = it.kind ? `<span style="font-size:11px;opacity:0.55;">${esc(it.kind)}</span>` : '';
  const sub = it.summary || it.detail || (it.advisory && it.advisory.summary) || '';
  return `<div class="inbox-item" style="border:1px solid var(--border);border-radius:6px;padding:9px;">
    <div><strong>${esc(title)}</strong> ${kind}</div>
    ${sub ? `<div style="font-size:12px;opacity:0.72;margin-top:4px;white-space:pre-wrap;">${esc(String(sub).slice(0, 400))}</div>` : ''}
  </div>`;
}

async function render(body) {
  const data = await aiosGet('/inbox');
  const items = (data && (data.items || data.cards)) || [];
  if (!items.length) {
    body.innerHTML = '<div style="opacity:0.6;padding:10px;">Inbox is empty.</div>';
    return;
  }
  body.innerHTML = items.map(_item).join('');
}

const modal = createAiosModal({ id: 'aios-inbox-modal', title: 'Inbox', render, pollMs: 5000 });
export const openInbox = modal.open;
export const closeInbox = modal.close;
export const isInboxOpen = modal.isOpen;
export default { openInbox, closeInbox, isInboxOpen };
