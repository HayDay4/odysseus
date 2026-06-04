/**
 * schedules.js — the Workshop cockpit's "Schedules" tab (Phase 2 T3).
 *
 * A full Routines CRUD surface, ported from the SvelteKit /schedules page into the
 * cockpit's --ck-* design vocabulary. Each routine is a cron-scheduled agent brief;
 * every firing is audited and nothing autonomous runs unless a routine is opted into
 * `auto` (vs `approve`, which parks the firing in the Inbox).
 *
 * Endpoints (all proxied in agents_routes.py):
 *   GET    /routines · /routines/{id}            list + detail (detail carries .runs)
 *   POST   /routines · PATCH /routines/{id}      create / edit
 *   DELETE /routines/{id}                        delete (+ firing log)
 *   POST   /routines/{id}/{pause,resume,run-now} lifecycle
 *   POST   /routine-runs/{id}/{approve,reject}   the autonomy gate (also in Inbox)
 *   GET    /goals · /roster                      link picker + agent picker
 *
 * Mirrors board.js / inboxTab.js discipline: transient state lives in the module,
 * so the workshop 5s poll re-render never clobbers a pane. While the create/edit
 * form is open the poll re-render is suppressed (so it can't steal input focus).
 */
import { aiosGet, aiosPost, aiosPatch, aiosDelete, esc } from './aiosShell.js';
import { ic } from './icons.js';
import { styledConfirm, styledAlert } from './ui.js';

const CRON_PRESETS = [
  { cron: '0 9 * * *', label: 'Daily 09:00' },
  { cron: '0 * * * *', label: 'Hourly' },
  { cron: '0 9 * * 1', label: 'Mon 09:00' },
  { cron: '0 9 1 * *', label: 'Monthly 1st' },
  { cron: '*/15 * * * *', label: 'Every 15m' },
];
const DRAFTER_MODES = ['quick', 'think', 'ensemble', 'via-hermes'];
const CONCURRENCY = ['skip_if_active', 'coalesce', 'always'];

const S2 = {
  loaded: false,
  routines: [],
  agents: [],
  goals: [],
  expanded: null,        // routine id whose detail is open
  detail: {},            // id -> detail (with .runs)
  formOpen: false,
  editingId: null,       // null = create
  form: blankForm(),
  busy: new Set(),
  msg: '',
};

function blankForm() {
  return {
    title: '', agent: '', instructions: '', cron: '0 9 * * *',
    autonomy: 'approve', drafter_mode: 'quick', concurrency: 'skip_if_active',
    goal_id: '', priority: 5, status: 'active',
  };
}

function fmtRel(iso, future) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  let secs = Math.floor((future ? t - Date.now() : Date.now() - t) / 1000);
  if (secs < 0) return future ? 'soon' : 'just now';
  const suffix = future ? '' : ' ago';
  const prefix = future ? 'in ' : '';
  if (secs < 60) return `${prefix}${secs}s${suffix}`;
  if (secs < 3600) return `${prefix}${Math.floor(secs / 60)}m${suffix}`;
  if (secs < 86400) return `${prefix}${Math.floor(secs / 3600)}h${suffix}`;
  return `${prefix}${Math.floor(secs / 86400)}d${suffix}`;
}

function goalTitle(id) {
  if (!id) return '';
  const g = S2.goals.find((x) => x.id === id);
  return g ? (g.title || id) : id;
}

export async function loadSchedules() {
  const [rr, ar, gr] = await Promise.all([
    aiosGet('/routines'), aiosGet('/roster'), aiosGet('/goals'),
  ]);
  S2.routines = (rr && rr.routines) || [];
  S2.agents = (ar && (ar.agents || ar.roster)) || [];
  S2.goals = (gr && gr.goals) || [];
  S2.loaded = true;
  return S2.routines.length;
}

function rerender() {
  const el = document.querySelector('#aios-cockpit-modal #ck-schedules');
  if (el) renderSchedules(el);
}

// The workshop 5s poll calls this (not renderSchedules) so it can be suppressed
// while the create/edit form is open — a full re-render mid-type would steal
// focus. Explicit user actions call renderSchedules directly and always render.
export async function pollRefresh() {
  if (S2.formOpen) return;             // don't clobber a form being filled
  const el = document.querySelector('#aios-cockpit-modal #ck-schedules');
  if (!el) return;
  await loadSchedules();
  if (!S2.formOpen) renderSchedules(el);
}

export function renderSchedules(el) {
  if (!el) return;
  if (!S2.loaded) {
    el.innerHTML = '<p class="ck-muted" style="padding:24px;">Loading routines…</p>';
    loadSchedules().then(() => renderSchedules(el));
    return;
  }
  el.innerHTML = `
    <div class="ck-sched-bar">
      <h4 class="ckb-rail-h">Schedules <span class="ckb-rail-n">${S2.routines.length}</span>
        <span class="ckb-rail-sub">Cron routines · audited firings</span></h4>
      <span style="flex:1"></span>
      <button id="ck-sched-new" class="ck-btn primary sm">${ic('plus')} New routine</button>
    </div>
    <div id="ck-sched-form"></div>
    <div class="ck-sched-list">
      ${S2.routines.length ? S2.routines.map(renderRoutine).join('')
        : '<p class="ck-muted ckb-empty">No routines yet. Create one to automate recurring work.</p>'}
    </div>`;
  bind(el);
  renderForm(el);
}

function renderRoutine(r) {
  const open = S2.expanded === r.id;
  const busy = S2.busy.has(r.id);
  const auto = r.autonomy === 'auto';
  const paused = r.status === 'paused';
  return `<div class="ck-sched-card ${paused ? 'paused' : ''} ${r.status === 'archived' ? 'archived' : ''}" data-id="${esc(r.id)}">
    <div class="ck-sched-top">
      <button class="ck-sched-title-btn" data-toggle="${esc(r.id)}">
        <span class="ck-sched-title">${esc(r.title || r.id)}</span>
      </button>
      <span class="ckb-chip ${auto ? '' : 'ghost'}" title="autonomy">${auto ? 'auto' : 'approval'}</span>
      <span class="ckb-chip ghost">${esc(r.drafter_mode || 'quick')}</span>
      <div class="ck-sched-actions">
        <button class="ck-btn ghost sm ck-sched-toggle-status" data-id="${esc(r.id)}" ${busy ? 'disabled' : ''}
          title="${paused ? 'Resume' : 'Pause'}">${paused ? ic('play') : ic('cancel')}</button>
        <button class="ck-btn ghost sm ck-sched-run" data-id="${esc(r.id)}" ${busy ? 'disabled' : ''} title="Run now">${ic('bolt')}</button>
        <button class="ck-btn ghost sm ck-sched-edit" data-id="${esc(r.id)}" title="Edit">Edit</button>
        <button class="ck-btn ghost sm ck-sched-del" data-id="${esc(r.id)}" title="Delete">${ic('close')}</button>
      </div>
    </div>
    <div class="ck-sched-meta">
      <span class="ck-run-prof">${esc(r.agent || '?')}</span>
      <code class="ckb-runid">${esc(r.cron || '')}</code>
      ${r.schedule_human ? `<span class="ck-muted">${esc(r.schedule_human)}</span>` : ''}
      ${r.goal_id ? `<span class="ck-muted">→ ${esc(goalTitle(r.goal_id))}</span>` : ''}
      <span style="flex:1"></span>
      <span class="ck-muted">next: <code>${esc(fmtRel(r.next_run_at, true))}</code></span>
      ${r.last_fired_at ? `<span class="ck-muted">last: <code>${esc(fmtRel(r.last_fired_at, false))}</code></span>` : ''}
    </div>
    ${open ? renderDetail(r) : ''}
  </div>`;
}

function renderDetail(r) {
  const det = S2.detail[r.id];
  if (det === 'loading' || det === undefined) return '<div class="ck-sched-detail"><p class="ck-muted">Loading…</p></div>';
  const runs = Array.isArray(det.runs) ? det.runs : [];
  const log = runs.length
    ? runs.map((run) => {
        const pending = run.status === 'pending_approval';
        return `<div class="ck-sched-fire">
          <span class="ck-sched-firestatus s-${esc(run.status)}">${esc(run.status)}</span>
          <code class="ck-muted">${esc(fmtRel(run.fired_at, false))}</code>
          <span class="ck-muted">${esc(run.source || '')}</span>
          ${run.skip_reason ? `<span class="ck-muted">(${esc(run.skip_reason)})</span>` : ''}
          <span style="flex:1"></span>
          ${pending ? `<button class="ck-btn primary sm ck-sched-rr" data-rr="${esc(run.id)}" data-act="approve">Approve</button>
            <button class="ck-btn ghost sm ck-sched-rr" data-rr="${esc(run.id)}" data-act="reject">Reject</button>` : ''}
        </div>`;
      }).join('')
    : '<p class="ck-muted" style="font-size:12px;">No firings recorded yet.</p>';
  return `<div class="ck-sched-detail">
    <div class="ckb-enrich"><span class="ckb-enrich-k">instructions</span></div>
    <pre class="ck-pre ck-sched-instr">${esc(det.instructions || '(none)')}</pre>
    <div class="ckb-enrich"><span class="ckb-enrich-k">firing log</span></div>
    <div class="ck-sched-firelog">${log}</div>
  </div>`;
}

function renderForm(el) {
  const slot = el.querySelector('#ck-sched-form');
  if (!slot) return;
  if (!S2.formOpen) { slot.innerHTML = ''; return; }
  const f = S2.form;
  const agentOpts = S2.agents.map((a) => {
    const name = a.name || a;
    return `<option value="${esc(name)}" ${name === f.agent ? 'selected' : ''}>${esc(name)}</option>`;
  }).join('');
  const goalOpts = ['<option value="">— none —</option>'].concat(
    S2.goals.map((g) => `<option value="${esc(g.id)}" ${g.id === f.goal_id ? 'selected' : ''}>${esc(g.title || g.id)}</option>`)
  ).join('');
  slot.innerHTML = `<div class="ck-sched-editor">
    <div class="ck-sched-editor-h">${S2.editingId ? 'Edit routine' : 'New routine'}</div>
    <label class="ck-field">Title
      <input id="sf-title" value="${esc(f.title)}" placeholder="e.g. Daily market scan"></label>
    <div class="ck-form-row">
      <label class="ck-field">Agent
        <select id="sf-agent"><option value="">(pick an agent)</option>${agentOpts}</select></label>
      <label class="ck-field">Drafter mode
        <select id="sf-drafter">${DRAFTER_MODES.map((m) => `<option value="${m}" ${m === f.drafter_mode ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
    </div>
    <label class="ck-field">Instructions <span class="ck-muted" style="text-transform:none;font-weight:400">— supports {{var}} interpolation</span>
      <textarea id="sf-instr" rows="3" placeholder="Task the agent should perform…">${esc(f.instructions)}</textarea></label>
    <label class="ck-field">Schedule (cron)
      <input id="sf-cron" value="${esc(f.cron)}" placeholder="0 9 * * *"></label>
    <div class="ck-sched-presets">
      ${CRON_PRESETS.map((p) => `<button class="ck-chip-btn ck-sched-preset" data-cron="${esc(p.cron)}">${esc(p.label)}</button>`).join('')}
    </div>
    <div class="ck-form-row">
      <label class="ck-field">Autonomy
        <select id="sf-autonomy">
          <option value="approve" ${f.autonomy === 'approve' ? 'selected' : ''}>approve — park for review</option>
          <option value="auto" ${f.autonomy === 'auto' ? 'selected' : ''}>auto — fire automatically</option></select></label>
      <label class="ck-field">Concurrency
        <select id="sf-concurrency">${CONCURRENCY.map((c) => `<option value="${c}" ${c === f.concurrency ? 'selected' : ''}>${c.replace(/_/g, ' ')}</option>`).join('')}</select></label>
    </div>
    <div class="ck-form-row">
      <label class="ck-field">Linked goal
        <select id="sf-goal">${goalOpts}</select></label>
      <label class="ck-field">Priority
        <input id="sf-priority" type="number" min="1" max="10" value="${esc(f.priority)}"></label>
    </div>
    <div class="ck-actions">
      <button id="sf-save" class="ck-btn primary sm">${S2.editingId ? 'Save changes' : 'Create routine'}</button>
      <button id="sf-cancel" class="ck-btn ghost sm">Cancel</button>
      <span id="sf-msg" class="ck-muted">${esc(S2.msg)}</span>
    </div>
  </div>`;
  const set = (k) => (e) => { f[k] = e.target.value; };
  slot.querySelector('#sf-title').addEventListener('input', set('title'));
  slot.querySelector('#sf-agent').addEventListener('change', set('agent'));
  slot.querySelector('#sf-drafter').addEventListener('change', set('drafter_mode'));
  slot.querySelector('#sf-instr').addEventListener('input', set('instructions'));
  slot.querySelector('#sf-cron').addEventListener('input', set('cron'));
  slot.querySelector('#sf-autonomy').addEventListener('change', set('autonomy'));
  slot.querySelector('#sf-concurrency').addEventListener('change', set('concurrency'));
  slot.querySelector('#sf-goal').addEventListener('change', set('goal_id'));
  slot.querySelector('#sf-priority').addEventListener('input', set('priority'));
  slot.querySelectorAll('.ck-sched-preset').forEach((b) =>
    b.addEventListener('click', () => { f.cron = b.dataset.cron; slot.querySelector('#sf-cron').value = f.cron; }));
  slot.querySelector('#sf-cancel').addEventListener('click', closeForm);
  slot.querySelector('#sf-save').addEventListener('click', submitForm);
}

function bind(el) {
  el.querySelector('#ck-sched-new')?.addEventListener('click', openCreate);
  el.querySelectorAll('[data-toggle]').forEach((b) =>
    b.addEventListener('click', () => toggleDetail(b.dataset.toggle)));
  el.querySelectorAll('.ck-sched-toggle-status').forEach((b) =>
    b.addEventListener('click', () => togglePause(b.dataset.id)));
  el.querySelectorAll('.ck-sched-run').forEach((b) =>
    b.addEventListener('click', () => runNow(b.dataset.id)));
  el.querySelectorAll('.ck-sched-edit').forEach((b) =>
    b.addEventListener('click', () => openEdit(b.dataset.id)));
  el.querySelectorAll('.ck-sched-del').forEach((b) =>
    b.addEventListener('click', () => del(b.dataset.id)));
  el.querySelectorAll('.ck-sched-rr').forEach((b) =>
    b.addEventListener('click', () => routineRun(b.dataset.rr, b.dataset.act)));
}

// ── actions ──────────────────────────────────────────────────────────────────
function openCreate() {
  S2.editingId = null; S2.form = blankForm();
  if (S2.agents.length) S2.form.agent = S2.agents[0].name || S2.agents[0];
  S2.formOpen = true; S2.msg = '';
  const el = document.querySelector('#aios-cockpit-modal #ck-schedules');
  if (el) renderSchedules(el);
}

function openEdit(id) {
  const r = S2.routines.find((x) => x.id === id);
  if (!r) return;
  S2.editingId = id;
  S2.form = {
    title: r.title || '', agent: r.agent || '', instructions: r.instructions || '',
    cron: r.cron || '0 9 * * *', autonomy: r.autonomy || 'approve',
    drafter_mode: r.drafter_mode || 'quick', concurrency: r.concurrency || 'skip_if_active',
    goal_id: r.goal_id || '', priority: r.priority ?? 5, status: r.status || 'active',
  };
  S2.formOpen = true; S2.msg = '';
  const el = document.querySelector('#aios-cockpit-modal #ck-schedules');
  if (el) renderSchedules(el);
}

function closeForm() {
  S2.formOpen = false; S2.editingId = null; S2.msg = '';
  rerender();
}

async function submitForm() {
  const f = S2.form;
  if (!f.title.trim() || !f.agent) { S2.msg = 'title + agent required'; renderForm(document.querySelector('#aios-cockpit-modal #ck-schedules')); return; }
  S2.msg = 'saving…';
  renderForm(document.querySelector('#aios-cockpit-modal #ck-schedules'));
  const body = {
    title: f.title.trim(), agent: f.agent, instructions: f.instructions.trim(),
    cron: f.cron.trim(), autonomy: f.autonomy, drafter_mode: f.drafter_mode,
    concurrency: f.concurrency, status: f.status, priority: Number(f.priority) || 5,
    goal_id: f.goal_id || undefined,
  };
  const res = S2.editingId
    ? await aiosPatch(`/routines/${encodeURIComponent(S2.editingId)}`, body)
    : await aiosPost('/routines', body);
  if (!res || res.ok === false || res.error) {
    S2.msg = `failed: ${(res && (res.error || res.detail)) || 'unknown'}`;
    renderForm(document.querySelector('#aios-cockpit-modal #ck-schedules'));
    return;
  }
  S2.formOpen = false; S2.editingId = null; S2.msg = '';
  await loadSchedules();
  const el = document.querySelector('#aios-cockpit-modal #ck-schedules');
  if (el) renderSchedules(el);
}

async function toggleDetail(id) {
  if (S2.expanded === id) { S2.expanded = null; rerender(); return; }
  S2.expanded = id;
  if (!S2.detail[id] || S2.detail[id] === 'loading') {
    S2.detail[id] = 'loading'; rerender();
    const d = await aiosGet(`/routines/${encodeURIComponent(id)}`);
    S2.detail[id] = (d && !d.error) ? d : { runs: [] };
  }
  rerender();
}

async function togglePause(id) {
  const r = S2.routines.find((x) => x.id === id);
  if (!r) return;
  const action = r.status === 'active' ? 'pause' : 'resume';
  S2.busy.add(id); rerender();
  await aiosPost(`/routines/${encodeURIComponent(id)}/${action}`, {});
  S2.busy.delete(id);
  await loadSchedules(); rerender();
}

async function runNow(id) {
  const r = S2.routines.find((x) => x.id === id);
  if (!await styledConfirm(`Fire "${(r && r.title) || id}" now?`, { confirmText: 'Run now' })) return;
  S2.busy.add(id); rerender();
  const res = await aiosPost(`/routines/${encodeURIComponent(id)}/run-now`, {});
  S2.busy.delete(id);
  await styledAlert(res && res.ok ? 'Routine fired.' : `Failed: ${(res && (res.error || res.detail)) || 'unknown'}`,
    { title: res && res.ok ? 'Fired' : 'Run failed', danger: !(res && res.ok) });
  await loadSchedules(); rerender();
}

async function del(id) {
  const r = S2.routines.find((x) => x.id === id);
  if (!await styledConfirm(`Delete "${(r && r.title) || id}" and its entire firing log? This cannot be undone.`,
    { confirmText: 'Delete', danger: true })) return;
  const res = await aiosDelete(`/routines/${encodeURIComponent(id)}`);
  if (res && res.error) { await styledAlert(`Delete failed: ${res.error}`, { title: 'Delete failed', danger: true }); return; }
  if (S2.expanded === id) S2.expanded = null;
  delete S2.detail[id];
  await loadSchedules(); rerender();
}

async function routineRun(rrId, action) {
  const res = await aiosPost(`/routine-runs/${encodeURIComponent(rrId)}/${action}`, {});
  if (!res || res.ok === false || res.error) {
    await styledAlert(`${action} failed: ${(res && (res.error || res.detail)) || 'unknown'}`, { title: 'Failed', danger: true });
    return;
  }
  // refresh the open detail's firing log
  if (S2.expanded) {
    const d = await aiosGet(`/routines/${encodeURIComponent(S2.expanded)}`);
    S2.detail[S2.expanded] = (d && !d.error) ? d : { runs: [] };
  }
  await loadSchedules(); rerender();
}

export default { loadSchedules, renderSchedules, pollRefresh };
