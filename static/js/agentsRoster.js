/**
 * agentsRoster.js — native Agents Roster + Budgets view (MIGRATION_PLAN §7).
 * Source: GET /api/aios/roster → {agents:[...]} (proxied to panel /api/agents/roster).
 */
import { createAiosModal, aiosGet, esc } from './aiosShell.js';
import { openCostDrill } from './costDrill.js';

function _row(a) {
  const cost = (a.cost_this_week != null) ? `$${Number(a.cost_this_week).toFixed(2)}` : '—';
  const budget = (a.budget_pct != null) ? `${a.budget_pct}%` : '—';
  const overCls = a.over_budget ? ' aios-over' : '';
  const sub = [esc(a.kind || ''), a.domain ? esc(a.domain) : ''].filter(Boolean).join(' · ');
  const open = [];
  if (a.open_issues) open.push(`${a.open_issues} issue${a.open_issues > 1 ? 's' : ''}`);
  if (a.inbox_depth) open.push(`${a.inbox_depth} queued`);
  return `<tr class="aios-row-click" data-agent="${esc(a.name)}" title="View cost breakdown">
    <td>
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="aios-dot ${a.active_now ? 'live' : ''}"></span>
        <strong>${esc(a.name)}</strong>
      </div>
      ${sub ? `<div class="aios-sub" style="margin-left:16px;">${sub}</div>` : ''}
    </td>
    <td class="num">${esc(String(a.runs_this_week ?? 0))}</td>
    <td class="num">${cost}</td>
    <td class="num${overCls}">${budget}</td>
    <td class="aios-meta">${open.join(' · ') || '—'}</td>
  </tr>`;
}

async function render(body) {
  const data = await aiosGet('/roster');
  const agents = (data && data.agents) || [];
  if (!agents.length) {
    body.innerHTML = '<div class="aios-empty">No agents in the roster.</div>';
    return;
  }
  body.innerHTML = `
    <div class="aios-table-hint">Tap an agent to see its cost breakdown by report &amp; task.</div>
    <table class="aios-table">
      <thead><tr>
        <th>Agent</th><th class="num">Runs/wk</th><th class="num">Cost/wk</th>
        <th class="num">Budget</th><th>Open work</th>
      </tr></thead>
      <tbody>${agents.map(_row).join('')}</tbody>
    </table>`;
  body.querySelectorAll('.aios-row-click').forEach((tr) =>
    tr.addEventListener('click', () => openCostDrill(tr.dataset.agent)));
}

const modal = createAiosModal({ id: 'aios-roster-modal', title: 'Agents Roster & Budgets', render, pollMs: 5000 });
export const openRoster = modal.open;
export const closeRoster = modal.close;
export const isRosterOpen = modal.isOpen;
export default { openRoster, closeRoster, isRosterOpen };
