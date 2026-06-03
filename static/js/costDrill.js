/**
 * costDrill.js — cost / spend drill-down for the Agents Roster.
 *
 * Tap an agent in the roster → open this panel. It shows the agent's weekly
 * spend + run count, a bar chart of its direct reports' weekly cost (drill into
 * a manager → its reports; CEO → CFO/CTO → specialists), and a per-task spend
 * breakdown for the agent itself.
 *
 * All from existing endpoints: /roster (per-agent weekly cost), /org (hierarchy),
 * /runs/history?profile=<name> (per-run cost + task). No charting library — the
 * bars are CSS, theme-tinted.
 */
import { createAiosModal, aiosGet, esc } from './aiosShell.js';
import { openRunSummary } from './runSummary.js';

let _roster = null;       // name -> roster row
let _children = null;     // name -> [child names]
let _path = [];           // breadcrumb of agent names (root → current)

async function _ensureData() {
  if (_roster && _children) return;
  const [r, o] = await Promise.all([aiosGet('/roster'), aiosGet('/org')]);
  _roster = {};
  ((r && r.agents) || []).forEach((a) => { if (a && a.name) _roster[a.name] = a; });
  _children = {};
  const walk = (n) => {
    if (!n || !n.name) return;
    _children[n.name] = (n.children || []).map((c) => c.name).filter(Boolean);
    (n.children || []).forEach(walk);
  };
  if (o && o.root) walk(o.root);
}

const _fmt = (v) => '$' + Number(v || 0).toFixed(2);

function _bars(items, kind) {
  // kind: 'reports' (drill into team) | 'tasks' (open run summary) | null (static)
  if (!items.length) return '<div class="cost-empty">No spend recorded.</div>';
  const max = Math.max(0.000001, ...items.map((i) => i.value));
  return '<div class="cost-bars">' + items.map((i) => {
    const pct = Math.max(3, Math.round((i.value / max) * 100));
    const sub = i.sub ? `<span class="cost-bar-sub">${esc(i.sub)}</span>` : '';
    let cls = '', attr = 'disabled';
    if (kind === 'reports' && i.name) { cls = 'drillable'; attr = `data-drill="${esc(i.name)}"`; }
    else if (kind === 'tasks' && i.runId) { cls = 'drillable'; attr = `data-run="${esc(i.runId)}"`; }
    return `<button class="cost-bar ${cls}" ${attr}>
      <span class="cost-bar-label">${esc(i.label)}${sub}</span>
      <span class="cost-bar-track"><span class="cost-bar-fill" style="width:${pct}%"></span></span>
      <span class="cost-bar-val">${_fmt(i.value)}</span>
    </button>`;
  }).join('') + '</div>';
}

async function render(body) {
  await _ensureData();
  const name = _path[_path.length - 1];
  const agent = _roster[name] || { name };
  const reports = (_children[name] || []).filter((n) => _roster[n]);

  const crumbs = _path.map((n, i) =>
    `<button class="cost-crumb" data-idx="${i}">${esc(n)}</button>`
  ).join('<span class="cost-crumb-sep">›</span>');

  let html = `
    <div class="cost-crumbs">${crumbs}</div>
    <div class="cost-head-main">
      <div>
        <div class="cost-agent">${esc(name)}</div>
        <div class="aios-sub">${esc(agent.kind || '')}${agent.domain ? ' · ' + esc(agent.domain) : ''}</div>
      </div>
      <div class="cost-stat"><span class="cost-stat-v">${_fmt(agent.cost_this_week)}</span><span class="cost-stat-l">this week</span></div>
      <div class="cost-stat"><span class="cost-stat-v">${agent.runs_this_week ?? 0}</span><span class="cost-stat-l">runs</span></div>
    </div>`;

  if (reports.length) {
    const items = reports
      .map((n) => ({ label: n, sub: _roster[n].domain || _roster[n].kind || '', value: _roster[n].cost_this_week || 0, name: n }))
      .sort((a, b) => b.value - a.value);
    html += `<div class="cost-section">
      <div class="cost-section-h">Direct reports — cost this week</div>
      <div class="cost-drill-hint">Tap a report to drill into its team.</div>
      ${_bars(items, 'reports')}
    </div>`;
  }

  html += `<div class="cost-section">
    <div class="cost-section-h">${esc(name)} — spend by task</div>
    <div class="cost-drill-hint">Tap a task to see what the run did.</div>
    <div id="cost-tasks"><div class="cost-empty">Loading…</div></div>
  </div>`;

  body.innerHTML = html;
  body.querySelectorAll('.cost-crumb').forEach((b) =>
    b.addEventListener('click', () => { _path = _path.slice(0, Number(b.dataset.idx) + 1); render(body); }));
  body.querySelectorAll('.cost-section .cost-bar.drillable[data-drill]').forEach((b) =>
    b.addEventListener('click', () => { _path.push(b.dataset.drill); render(body); }));

  // Per-task spend (async; profile == agent name in runs.db). Each task keeps a
  // representative (most-recent) run so the bar can open that run's summary.
  const hist = await aiosGet(`/runs/history?profile=${encodeURIComponent(name)}&limit=100`);
  const runs = (hist && hist.runs) || [];
  const byTask = {};
  runs.forEach((r) => {
    const t = String(r.task || '(untitled)').slice(0, 60).trim() || '(untitled)';
    if (!byTask[t]) byTask[t] = { value: 0, run: r };   // runs are DESC → first = newest
    byTask[t].value += (Number(r.cost_usd) || 0);
  });
  const taskItems = Object.entries(byTask)
    .map(([label, v]) => ({ label, value: v.value, runId: v.run && v.run.id, _run: v.run }))
    .filter((i) => i.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);
  const el = document.querySelector('#aios-cost-modal #cost-tasks');
  if (el) {
    if (!taskItems.length) {
      el.innerHTML = '<div class="cost-empty">No per-task spend attributed in the last 100 runs.</div>';
    } else {
      el.innerHTML = _bars(taskItems, 'tasks');
      el.querySelectorAll('.cost-bar.drillable[data-run]').forEach((b) => {
        const item = taskItems.find((i) => i.runId === b.dataset.run);
        b.addEventListener('click', () => openRunSummary(item && item._run));
      });
    }
  }
}

const modal = createAiosModal({ id: 'aios-cost-modal', title: 'Cost breakdown', render });

export function openCostDrill(name) {
  _path = [name];
  if (modal.isOpen()) modal.close();
  modal.open();
}
export const closeCostDrill = modal.close;
export default { openCostDrill, closeCostDrill };
