/**
 * agentsRoster.js — native Agents Roster + Budgets view (MIGRATION_PLAN §7).
 * Source: GET /api/aios/roster → {agents:[...]} (proxied to panel /api/agents/roster).
 */
import { createAiosModal, aiosGet, esc } from './aiosShell.js';

function _row(a) {
  const cost = (a.cost_this_week != null) ? `$${Number(a.cost_this_week).toFixed(2)}` : '—';
  const budget = (a.budget_pct != null) ? `${a.budget_pct}%` : '—';
  const over = a.over_budget ? ' style="color:var(--red);font-weight:600;"' : '';
  const dot = a.active_now ? '🟢' : '⚪';
  const inbox = a.inbox_depth ? ` · 📥${a.inbox_depth}` : '';
  const issues = a.open_issues ? ` · ⚠${a.open_issues}` : '';
  return `<tr>
    <td>${dot} <strong>${esc(a.name)}</strong><div style="font-size:11px;opacity:0.6;">${esc(a.kind || '')}${a.domain ? ' · ' + esc(a.domain) : ''}</div></td>
    <td style="text-align:right;">${esc(String(a.runs_this_week ?? 0))}</td>
    <td style="text-align:right;">${cost}</td>
    <td style="text-align:right;"${over}>${budget}</td>
    <td style="font-size:11px;opacity:0.7;">${esc(String(a.open_issues || 0))}${inbox}${issues}</td>
  </tr>`;
}

async function render(body) {
  const data = await aiosGet('/roster');
  const agents = (data && data.agents) || [];
  if (!agents.length) {
    body.innerHTML = '<div style="opacity:0.6;padding:10px;">No agents in the roster.</div>';
    return;
  }
  body.innerHTML = `
    <table class="aios-table" style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead><tr style="text-align:left;border-bottom:1px solid var(--border);">
        <th>Agent</th><th style="text-align:right;">Runs/wk</th><th style="text-align:right;">Cost/wk</th>
        <th style="text-align:right;">Budget</th><th>Open</th>
      </tr></thead>
      <tbody>${agents.map(_row).join('')}</tbody>
    </table>`;
}

const modal = createAiosModal({ id: 'aios-roster-modal', title: 'Agents Roster & Budgets', render, pollMs: 5000 });
export const openRoster = modal.open;
export const closeRoster = modal.close;
export const isRosterOpen = modal.isOpen;
export default { openRoster, closeRoster, isRosterOpen };
