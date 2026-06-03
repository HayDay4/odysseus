/**
 * org.js — native Org tree view (MIGRATION_PLAN §7).
 * Source: GET /api/aios/org → {root:{name,kind,description,children:[...]}}.
 */
import { createAiosModal, aiosGet, esc } from './aiosShell.js';

function _node(n, depth) {
  if (!n) return '';
  const pad = depth * 16;
  const kids = (n.children || []).map((c) => _node(c, depth + 1)).join('');
  const kind = n.kind ? `<span style="font-size:11px;opacity:0.55;">${esc(n.kind)}</span>` : '';
  const desc = n.description ? `<div style="font-size:11px;opacity:0.6;">${esc(n.description)}</div>` : '';
  return `<div class="org-node" style="padding-left:${pad}px;margin:3px 0;border-left:1px solid var(--border);">
    <div><strong>${esc(n.name)}</strong> ${kind}</div>${desc}</div>${kids}`;
}

async function render(body) {
  const data = await aiosGet('/org');
  const root = data && data.root;
  if (!root) {
    body.innerHTML = '<div style="opacity:0.6;padding:10px;">Org tree unavailable.</div>';
    return;
  }
  body.innerHTML = `<div class="org-tree">${_node(root, 0)}</div>`;
}

const modal = createAiosModal({ id: 'aios-org-modal', title: 'Org Tree', render });
export const openOrg = modal.open;
export const closeOrg = modal.close;
export const isOrgOpen = modal.isOpen;
export default { openOrg, closeOrg, isOrgOpen };
