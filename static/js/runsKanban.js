/**
 * runsKanban.js — native Runs kanban (MIGRATION_PLAN §7 / P5-T5). Polls the AIOS
 * proxy (/api/aios/runs/active + /recent), groups runs by state, and opens the
 * live RunTerminal on card click. tasks.js-style 5s poll via the shared shell.
 */
import { createAiosModal, aiosGet, esc } from './aiosShell.js';
import runTerminalModule from './runTerminal.js';

// runs.db status → display column. active runs are in_progress; recent carry a
// terminal status (panel _DB_STATE: completed→done, failed/crashed, cancelled→killed).
const COLUMNS = [
  { key: 'active', label: 'Active', match: (s) => s === 'in_progress' },
  { key: 'done', label: 'Done', match: (s) => s === 'completed' },
  { key: 'failed', label: 'Failed', match: (s) => s === 'failed' || s === 'crashed' },
  { key: 'killed', label: 'Killed', match: (s) => s === 'cancelled' },
];

function _card(r) {
  const cost = (r.cost_usd != null && r.cost_usd > 0) ? ` · $${Number(r.cost_usd).toFixed(2)}` : '';
  const prof = r.profile ? ` · ${esc(r.profile)}` : '';
  const task = (r.task || '').slice(0, 90);
  return `<div class="kanban-card" data-run="${esc(r.id)}"
       style="border:1px solid var(--border);border-radius:6px;padding:7px;margin-bottom:6px;cursor:pointer;">
    <div style="font-size:11px;opacity:0.6;">${esc(r.short_id || r.id)}${prof}${cost}</div>
    <div style="font-size:12px;">${esc(task)}</div>
  </div>`;
}

async function render(body) {
  const [activeData, recentData] = await Promise.all([
    aiosGet('/runs/active'), aiosGet('/runs/recent'),
  ]);
  const runs = []
    .concat((activeData && activeData.runs) || [])
    .concat((recentData && recentData.runs) || []);
  const cols = COLUMNS.map((c) => {
    const items = runs.filter((r) => c.match(r.status));
    return `<div class="kanban-col" style="flex:1;min-width:0;">
      <div style="font-size:12px;font-weight:600;opacity:0.8;margin-bottom:6px;">
        ${esc(c.label)} <span style="opacity:0.5;">(${items.length})</span></div>
      ${items.map(_card).join('') || '<div style="opacity:0.4;font-size:11px;">—</div>'}
    </div>`;
  }).join('');
  body.innerHTML = `<div class="kanban-grid" style="display:flex;gap:10px;align-items:flex-start;">${cols}</div>`;
  body.querySelectorAll('.kanban-card').forEach((el) =>
    el.addEventListener('click', () => runTerminalModule.openRunTerminal(el.dataset.run)));
}

const modal = createAiosModal({ id: 'aios-kanban-modal', title: 'Runs', render, pollMs: 5000 });
export const openRunsKanban = modal.open;
export const closeRunsKanban = modal.close;
export const isRunsKanbanOpen = modal.isOpen;
export default { openRunsKanban, closeRunsKanban, isRunsKanbanOpen };
