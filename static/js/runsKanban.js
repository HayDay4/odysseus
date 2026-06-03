/**
 * runsKanban.js — native Runs kanban (MIGRATION_PLAN §7 / P5-T5). Polls the AIOS
 * proxy (/api/aios/runs/active + /recent), groups runs by state, and opens the
 * live RunTerminal on card click. tasks.js-style 5s poll via the shared shell.
 */
import { createAiosModal, aiosGet, esc } from './aiosShell.js';
import runTerminalModule from './runTerminal.js';
import { openRunSummary } from './runSummary.js';

// run_id -> run row, so a card click can branch on status + pass full data.
let _byId = {};

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
  return `<div class="aios-kcard" data-run="${esc(r.id)}">
    <div class="aios-kcard-meta">${esc(r.short_id || r.id)}${prof}${cost}</div>
    <div class="aios-kcard-task">${esc(task)}</div>
  </div>`;
}

async function render(body) {
  const [activeData, recentData] = await Promise.all([
    aiosGet('/runs/active'), aiosGet('/runs/recent'),
  ]);
  const runs = []
    .concat((activeData && activeData.runs) || [])
    .concat((recentData && recentData.runs) || []);
  _byId = {};
  runs.forEach((r) => { if (r && r.id) _byId[r.id] = r; });
  const cols = COLUMNS.map((c) => {
    const items = runs.filter((r) => c.match(r.status));
    return `<div class="aios-kcol">
      <div class="aios-kcol-h">${esc(c.label)} <span class="aios-kcount">${items.length}</span></div>
      ${items.map(_card).join('') || '<div class="aios-meta" style="padding:4px 2px;">—</div>'}
    </div>`;
  }).join('');
  body.innerHTML = `<div class="aios-kgrid">${cols}</div>`;
  // Active run → live terminal (it tails tool-calls.jsonl). Finished run → the
  // what-was-done summary (the live stream is gone once a run ends).
  body.querySelectorAll('.aios-kcard').forEach((el) =>
    el.addEventListener('click', () => {
      const r = _byId[el.dataset.run];
      if (r && r.status === 'in_progress') runTerminalModule.openRunTerminal(r.id);
      else openRunSummary(r || { id: el.dataset.run });
    }));
}

const modal = createAiosModal({ id: 'aios-kanban-modal', title: 'Runs', render, pollMs: 5000 });
export const openRunsKanban = modal.open;
export const closeRunsKanban = modal.close;
export const isRunsKanbanOpen = modal.isOpen;
export default { openRunsKanban, closeRunsKanban, isRunsKanbanOpen };
