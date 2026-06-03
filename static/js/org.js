/**
 * org.js — native Org tree view (MIGRATION_PLAN §7).
 * Source: GET /api/aios/org → {root:{name,kind,description,children:[...]}}.
 */
import { createAiosModal, aiosGet, esc } from './aiosShell.js';

function _node(n, depth) {
  if (!n) return '';
  const kids = (n.children || []).map((c) => _node(c, depth + 1)).join('');
  const kind = n.kind ? `<span class="aios-kind">${esc(n.kind)}</span>` : '';
  const desc = n.description ? `<div class="aios-org-desc">${esc(n.description)}</div>` : '';
  return `<div class="aios-org-node" style="margin-left:${depth * 18}px;">
    <div class="aios-org-row">
      <span class="aios-org-name">${esc(n.name)}</span> ${kind}
    </div>${desc}
  </div>${kids}`;
}

async function render(body) {
  const data = await aiosGet('/org');
  const root = data && data.root;
  if (!root) {
    body.innerHTML = '<div class="aios-empty">Org tree unavailable.</div>';
    return;
  }
  body.innerHTML = `<div class="aios-org-tree" style="display:flex;flex-direction:column;gap:4px;">${_node(root, 0)}</div>`;
}

const modal = createAiosModal({ id: 'aios-org-modal', title: 'Org Tree', render });
export const openOrg = modal.open;
export const closeOrg = modal.close;
export const isOrgOpen = modal.isOpen;
export default { openOrg, closeOrg, isOrgOpen };
