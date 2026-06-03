/**
 * agentsHub.js — launcher for the native AIOS workforce views (MIGRATION_PLAN §7).
 * One rail button ("Agents") opens this hub; each tile opens a glance view. Imports
 * the view modules one-directionally (no cycles — the views never import the hub).
 */
import { createAiosModal, esc } from './aiosShell.js';
import rosterModule from './agentsRoster.js';
import orgModule from './org.js';
import proposalsModule from './proposals.js';
import briefModule from './brief.js';
import inboxModule from './inbox.js';
import runsKanbanModule from './runsKanban.js';

const TILES = [
  { label: 'Agents Roster & Budgets', open: () => rosterModule.openRoster() },
  { label: 'Org Tree', open: () => orgModule.openOrg() },
  { label: 'Proposals', open: () => proposalsModule.openProposals() },
  { label: 'Brief / Spawn', open: () => briefModule.openBrief() },
  { label: 'Inbox', open: () => inboxModule.openInbox() },
  { label: 'Runs (kanban + live terminal)', open: () => runsKanbanModule.openRunsKanban() },
];

async function render(body) {
  body.innerHTML = `<div class="aios-hub-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
    ${TILES.map((t, i) => `<button class="btn aios-hub-tile" data-i="${i}"
        style="padding:14px;text-align:left;border:1px solid var(--border);border-radius:8px;">
        ${esc(t.label)}</button>`).join('')}
  </div>`;
  body.querySelectorAll('.aios-hub-tile').forEach((b) =>
    b.addEventListener('click', () => TILES[Number(b.dataset.i)].open()));
}

const modal = createAiosModal({ id: 'aios-hub-modal', title: 'AIOS Workforce', render });
export const openAgentsHub = modal.open;
export const closeAgentsHub = modal.close;
export const isAgentsHubOpen = modal.isOpen;
export default { openAgentsHub, closeAgentsHub, isAgentsHubOpen };
