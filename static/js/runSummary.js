/**
 * runSummary.js — "what was done" summary for a finished run.
 *
 * The live RunTerminal only makes sense for an in-progress run (it tails the
 * run's tool-calls.jsonl, which is gone once a run finishes). For a terminal
 * run we open THIS instead: task, status, duration, cost, token usage, and the
 * run's final assistant turn (the what-was-done summary) rendered as markdown.
 *
 * Source: the run row (passed in) + GET /api/aios/runs/{id}/output
 * (now returns {last_output, tokens:{input,output,cache_read,cache_write,total}}).
 */
import { createAiosModal, aiosGet, esc } from './aiosShell.js';
import { mdToHtml } from './markdown.js';

let _run = null;

function _fmtNum(n) {
  n = Number(n || 0);
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

function _fmtDur(a, b) {
  if (!a || !b) return '—';
  const s = Math.max(0, b - a);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function _statusClass(s) {
  if (s === 'completed') return 'done';
  if (s === 'failed' || s === 'crashed') return 'failed';
  if (s === 'cancelled') return 'killed';
  return 'active';
}

async function render(body) {
  const r = _run || {};
  const cost = (r.cost_usd != null) ? '$' + Number(r.cost_usd).toFixed(2) : '—';
  const stat = `<span class="rs-status ${_statusClass(r.status)}">${esc(r.status || 'unknown')}</span>`;

  body.innerHTML = `
    <div class="rs-head">
      <code class="rs-id">${esc(r.short_id || r.id || '')}</code>
      ${stat}
      ${r.profile ? `<span class="aios-kind">${esc(r.profile)}</span>` : ''}
    </div>
    <div class="rs-task">${esc(r.task || '(no task recorded)')}</div>
    <div class="rs-stats">
      <div class="rs-stat"><span class="rs-stat-v">${cost}</span><span class="rs-stat-l">cost</span></div>
      <div class="rs-stat"><span class="rs-stat-v" id="rs-tok">…</span><span class="rs-stat-l">tokens</span></div>
      <div class="rs-stat"><span class="rs-stat-v">${_fmtDur(r.created_at, r.completed_at)}</span><span class="rs-stat-l">duration</span></div>
    </div>
    <div id="rs-tokbreak" class="rs-tokbreak"></div>
    ${r.pr_url ? `<div class="rs-pr"><a href="${esc(r.pr_url)}" target="_blank" rel="noopener">View PR ↗</a></div>` : ''}
    <div class="cost-section-h" style="margin-top:18px;">What was done</div>
    <div id="rs-body"><div class="cost-empty">Loading summary…</div></div>`;

  const out = await aiosGet(`/runs/${encodeURIComponent(r.id)}/output`);
  const tok = out && out.tokens;
  const tokEl = document.querySelector('#aios-runsummary-modal #rs-tok');
  const tbEl = document.querySelector('#aios-runsummary-modal #rs-tokbreak');
  if (tokEl) tokEl.textContent = tok ? _fmtNum(tok.total) : '—';
  if (tbEl && tok) {
    tbEl.innerHTML =
      `<span>in <b>${_fmtNum(tok.input)}</b></span>` +
      `<span>out <b>${_fmtNum(tok.output)}</b></span>` +
      `<span>cache read <b>${_fmtNum(tok.cache_read)}</b></span>` +
      `<span>cache write <b>${_fmtNum(tok.cache_write)}</b></span>`;
  }
  const bodyEl = document.querySelector('#aios-runsummary-modal #rs-body');
  if (bodyEl) {
    if (out && out.ok && out.last_output) {
      bodyEl.innerHTML = `<div class="aios-md">${mdToHtml(out.last_output)}</div>`;
    } else {
      bodyEl.innerHTML = `<div class="cost-empty">${esc((out && out.error) || 'No final summary recorded for this run.')}</div>`;
    }
  }
}

const modal = createAiosModal({ id: 'aios-runsummary-modal', title: 'Run summary', render });

export function openRunSummary(run) {
  _run = run || {};
  if (modal.isOpen()) modal.close();
  modal.open();
}
export const closeRunSummary = modal.close;
export default { openRunSummary, closeRunSummary };
