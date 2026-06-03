/**
 * agentsHub.js — launcher for the native AIOS workforce views (MIGRATION_PLAN §7).
 * One rail button ("Agents") opens this hub; each tile opens a glance view. Imports
 * the view modules one-directionally (no cycles — the views never import the hub).
 */
import { createAiosModal, esc } from './aiosShell.js';
import rosterModule from './agentsRoster.js';
import orgModule from './org.js';
import proposalsModule from './proposals.js';
import inboxModule from './inbox.js';
import runsKanbanModule from './runsKanban.js';

// Minimal inline SVG glyphs (stroke=currentColor) — keep parity with the
// cockpit's icon language instead of emoji.
const _G = {
  roster: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  org: '<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M6 16v-2h12v2"/>',
  proposals: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h6"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5 5h14l3 7v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6z"/>',
  runs: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
};
// Brief/Spawn was dropped — the cockpit Workshop tab's Direct-launch supersedes it.
const TILES = [
  { icon: 'roster', label: 'Agents Roster', sub: 'budgets & cost drill-down', open: () => rosterModule.openRoster() },
  { icon: 'org', label: 'Org Tree', sub: 'reporting lines', open: () => orgModule.openOrg() },
  { icon: 'proposals', label: 'Proposals', sub: 'Hermes advisories', open: () => proposalsModule.openProposals() },
  { icon: 'inbox', label: 'Inbox', sub: 'decisions & tickets', open: () => inboxModule.openInbox() },
  { icon: 'runs', label: 'Runs', sub: 'kanban + live terminal', open: () => runsKanbanModule.openRunsKanban() },
];

function _svg(name) {
  return `<svg class="aios-tile-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${_G[name] || ''}</svg>`;
}

async function render(body) {
  body.innerHTML = `<div class="aios-hub-grid">
    ${TILES.map((t, i) => `<button class="aios-hub-tile" data-i="${i}">
        ${_svg(t.icon)}
        <span class="aios-tile-txt"><span class="aios-tile-label">${esc(t.label)}</span>
          <span class="aios-tile-sub">${esc(t.sub)}</span></span>
      </button>`).join('')}
  </div>`;
  body.querySelectorAll('.aios-hub-tile').forEach((b) =>
    b.addEventListener('click', () => TILES[Number(b.dataset.i)].open()));
}

const modal = createAiosModal({ id: 'aios-hub-modal', title: 'AIOS Workforce', render });
export const openAgentsHub = modal.open;
export const closeAgentsHub = modal.close;
export const isAgentsHubOpen = modal.isOpen;
export default { openAgentsHub, closeAgentsHub, isAgentsHubOpen };
