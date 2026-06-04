/**
 * agentsHub.js — launcher for the native AIOS workforce views (MIGRATION_PLAN §7).
 * One rail button ("Agents") opens this hub; each tile opens a glance view. Imports
 * the view modules one-directionally (no cycles — the views never import the hub).
 */
import { createAiosModal, esc } from './aiosShell.js';
import rosterModule from './agentsRoster.js';
import orgModule from './org.js';

// Minimal inline SVG glyphs (stroke=currentColor) — keep parity with the
// cockpit's icon language instead of emoji.
const _G = {
  roster: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  org: '<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M6 16v-2h12v2"/>',
  proposals: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h6"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5 5h14l3 7v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6z"/>',
  runs: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  grill: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h4"/>',
};
// "New brief" opens a project picker, then runs the SAME path as typing
// `/grill-me <slug>` (confirmation bubble + existing-work context) so the tile
// and the slash command behave identically. Dynamic imports keep agentsHub off
// the grillme→workshop→agentsHub static import cycle.
let _grillPicker = null;
async function _startGrillme() {
  let projects = [];
  try {
    const r = await fetch(`${window.location.origin}/api/aios/projects`, { credentials: 'same-origin' });
    const d = r.ok ? await r.json() : null;
    projects = (d && (d.projects || d)) || [];
  } catch { /* fall back to no-project start */ }

  const run = (slug) => {
    if (_grillPicker) _grillPicker.close();
    closeAgentsHub();
    import('./slashCommands.js')
      .then((m) => (m.handleSlashCommand || m.default.handleSlashCommand)('/grill-me' + (slug ? ' ' + slug : '')))
      .catch(() => {});
  };

  _grillPicker = createAiosModal({
    id: 'grillme-pick-modal',
    title: 'New brief — pick a project',
    render(body) {
      const items = projects.slice(0, 40).map((p) =>
        `<button class="aios-hub-tile grillme-pick" data-slug="${esc(p.slug)}" style="width:100%;text-align:left;">
           <span class="aios-tile-label">${esc(p.slug)}</span></button>`).join('')
        || '<p class="ck-muted">No projects found.</p>';
      body.innerHTML =
        `<p class="ck-muted" style="margin:0 0 8px;">The local model will interrogate you to build a brief, then hand it to the cockpit.</p>
         <div style="display:flex;flex-direction:column;gap:4px;max-height:50vh;overflow:auto;">${items}</div>
         <div style="margin-top:8px;"><button class="aios-hub-tile grillme-pick" data-slug="" style="width:100%;">Start without a project</button></div>`;
      body.querySelectorAll('.grillme-pick').forEach((b) =>
        b.addEventListener('click', () => run(b.dataset.slug)));
    },
  });
  _grillPicker.open();
}
// "Classic views" is now slimmed to the surfaces with NO cockpit home of their
// own (Phase 2 T7): the grill-me intake + roster + org. Superseded + removed:
//   Brief/Spawn  → cockpit Workshop Direct-launch
//   Proposals    → cockpit Board "Advisory (Hermes)" rail
//   Inbox        → cockpit [Inbox] tab (governance/approvals feed)
//   Runs         → cockpit Workshop WORK list + run detail (/runs routes here)
const TILES = [
  { icon: 'grill', label: 'New brief (/grill-me)', sub: 'local intake → cockpit', open: _startGrillme },
  { icon: 'roster', label: 'Agents Roster', sub: 'budgets & cost drill-down', open: () => rosterModule.openRoster() },
  { icon: 'org', label: 'Org Tree', sub: 'reporting lines', open: () => orgModule.openOrg() },
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
