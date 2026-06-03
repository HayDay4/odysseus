/**
 * workshop.js — the AIOS "Workshop" management cockpit (COCKPIT_PROMPT §2-3).
 *
 * Replaces the thin 6-tile agentsHub as the PRIMARY workforce view. Full-window
 * modal with two tabs ([Workshop] [Board]) + an always-visible Decisions strip.
 *
 * Phase A (this file's first cut) builds the Workshop tab: a projects rail, a
 * faithful port of the legacy /launch Direct-launch flow (profile picker +
 * Quick/Think/Ensemble + via-Hermes + Draft→edit→Spawn), a WORK list of the
 * project's runs, and a RUN DETAIL pane (live terminal via runTerminal.js, last
 * output, and a Changes/diff view with cancel/PR/follow actions). The Board tab
 * is a placeholder until Phase B; "Ask the brain" is stubbed until Phase C.
 *
 * Standalone modal lifecycle (mirrors runTerminal.js) so we control the wide
 * 3-column layout directly instead of the narrow createAiosModal shell. The
 * spawn form's editable state lives in JS (not the DOM) so the poll tick can
 * refresh the rail / WORK / Decisions without clobbering what you're typing.
 */
import { aiosGet, aiosPost, esc } from './aiosShell.js';
import { openRunTerminal } from './runTerminal.js';
import agentsHubModule from './agentsHub.js';

const MODE_HELP = {
  quick: 'Sonnet 4.6 · ~$0.003 · ~10s',
  think: 'Opus + thinking · ~$0.05 · ~20s',
  ensemble: 'Sonnet + Hermes → Opus · ~$0.10 · ~30s',
};

// ── Inline SVG icon set (stroke=currentColor) — no emoji, theme-tinted ──────
const _IC = {
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  play: '<path d="M8 5l11 7-11 7z" fill="currentColor" stroke="none"/>',
  cancel: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
  branch: '<circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="7" r="2.4"/><path d="M6 8.4v7.2M18 9.4c0 4.2-5.4 2.4-6 5.6"/>',
  brain: '<path d="M9 3a3 3 0 0 0-3 3 3 3 0 0 0-1.5 5.6A3 3 0 0 0 6 18a3 3 0 0 0 6 .5V4.5A3 3 0 0 0 9 3z"/><path d="M15 3a3 3 0 0 1 3 3 3 3 0 0 1 1.5 5.6A3 3 0 0 1 18 18a3 3 0 0 1-6 .5"/>',
  bolt: '<path d="M13 3L5 13h5l-1 8 8-10h-5z" fill="currentColor" stroke="none"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
};
function ic(name, cls) {
  return `<svg class="ck-ic ${cls || ''}" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true">${_IC[name] || ''}</svg>`;
}

const S = {
  open: false,
  escHandler: null,
  pollTimer: null,
  tab: 'workshop',
  projects: [],
  profiles: [],
  activeRuns: [],
  recentRuns: [],
  selectedSlug: null,
  selectedRunId: null,
  detailTab: 'output',          // 'output' | 'changes'
  // spawn form (Direct launch)
  mode: 'quick',
  viaHermes: false,
  profile: '',
  task: '',
  drafting: false,
  spawning: false,
  draftResult: null,            // {ok, output, error, stderr}
  editedPrompt: '',
  // /grill-me handoff (GRILLME_PROMPT.md): a brief pre-filled from local intake.
  // When set, the spawn area offers "Evaluate (Opus plan)" instead of a direct
  // spawn — the grilled brief is reviewed by Opus in plan mode before any code.
  brief: null,                  // normalized handoff dict (slug/profile/mode/...)
  briefScrubbed: '',            // egress-approved brief text (the prompt body)
  briefQueue: [],               // remaining suggested_decomposition items (item 2+)
  planRunId: null,              // run_id of the Opus plan-mode evaluation run
  decisions: { in_review: 0, proposals: 0, questions: 0 },
};

// ── JSON-tail extractor (ported from launch/+page.svelte) ──────────────────
// The drafter appends a {prompt, project_dir, memory_used, ...} JSON object after
// the human-readable output; pull the prompt out of the last balanced {...}.
function extractDraftPrompt(text) {
  const trimmed = String(text || '').trim();
  let depth = 0, lastClose = -1;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    if (trimmed[i] === '}') { if (lastClose === -1) lastClose = i; depth++; }
    else if (trimmed[i] === '{') {
      depth--;
      if (depth === 0 && lastClose !== -1) {
        try {
          const obj = JSON.parse(trimmed.slice(i, lastClose + 1));
          if (obj && typeof obj.prompt === 'string') return obj.prompt;
        } catch { lastClose = -1; }
      }
    }
  }
  return text;   // no JSON tail → use raw output as the prompt
}

function projBasename(dir) {
  const parts = String(dir || '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function activeCountForSlug(slug) {
  return S.activeRuns.filter((r) => projBasename(r.project_dir) === slug).length;
}

function runsForSlug(slug) {
  const match = (r) => projBasename(r.project_dir) === slug;
  return { active: S.activeRuns.filter(match), recent: S.recentRuns.filter(match) };
}

function fmtAge(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

// ── Data loaders ───────────────────────────────────────────────────────────
async function loadProjects() {
  const d = await aiosGet('/projects');
  S.projects = (d && d.projects) || [];
  if (!S.selectedSlug && S.projects.length) S.selectedSlug = S.projects[0].slug;
}
async function loadProfiles() {
  const d = await aiosGet('/profiles');
  S.profiles = (d && d.profiles) || [];
}
async function loadRuns() {
  const [a, r] = await Promise.all([aiosGet('/runs/active'), aiosGet('/runs/recent')]);
  S.activeRuns = (a && a.runs) || [];
  S.recentRuns = (r && r.runs) || [];
}
async function loadDecisions() {
  // Phase A wires only the proposals count (its proxy already exists). The
  // issues + questions proxy routes land in Phase B (B1); until then we leave
  // those counters at 0 rather than fetch routes that would 404 in the console.
  const props = await aiosGet('/proposals');
  S.decisions.proposals = (props && (props.proposals || props).length) || 0;
}

// ── Region renders ─────────────────────────────────────────────────────────
function renderDecisions() {
  const el = document.querySelector('#aios-cockpit-modal #ck-decisions');
  if (!el) return;
  const d = S.decisions;
  const pill = (n, label, tone) => `<span class="ck-dec ${n ? 'hot ' + tone : ''}">
    <span class="ck-dec-dot"></span><span class="ck-dec-n">${n}</span> ${label}</span>`;
  el.innerHTML =
    pill(d.in_review, 'in&nbsp;review', 'warn') +
    pill(d.proposals, 'proposals', 'accent') +
    pill(d.questions, 'questions', 'info');
}

function renderRail() {
  const el = document.querySelector('#aios-cockpit-modal #ck-rail');
  if (!el) return;
  if (!S.projects.length) { el.innerHTML = '<p class="ck-muted">No projects.</p>'; return; }
  el.innerHTML = S.projects.map((p) => {
    const n = activeCountForSlug(p.slug);
    const sel = p.slug === S.selectedSlug ? 'sel' : '';
    return `<button class="ck-proj ${sel}" data-slug="${esc(p.slug)}">
      <span class="ck-proj-slug">${esc(p.slug)}</span>
      ${n ? `<span class="ck-badge live"><span class="ck-dot"></span>${n}</span>` : ''}
    </button>`;
  }).join('');
  el.querySelectorAll('.ck-proj').forEach((b) =>
    b.addEventListener('click', () => selectProject(b.dataset.slug)));
}

function renderSpawn() {
  const el = document.querySelector('#aios-cockpit-modal #ck-spawn');
  if (!el) return;
  const proj = S.projects.find((p) => p.slug === S.selectedSlug);
  if (!proj) { el.innerHTML = '<p class="ck-muted">Select a project.</p>'; return; }
  const modes = ['quick', 'think', 'ensemble'];
  el.innerHTML = `
    <div class="ck-proj-head">
      <div>
        <div class="ck-eyebrow">${esc(proj.category || 'project')}</div>
        <h2 class="ck-proj-title">${esc(proj.slug)}</h2>
      </div>
    </div>
    <div class="ck-launch-paths">
      <label class="ck-seg active"><input type="radio" name="ck-path" value="direct" checked>
        ${ic('bolt')}<span>Direct launch</span></label>
      <label class="ck-seg ck-disabled" title="Wired in Phase C"><input type="radio" name="ck-path" value="brain" disabled>
        ${ic('brain')}<span>Ask the brain</span></label>
    </div>
    <textarea id="ck-task" rows="3" placeholder="task / intent…">${esc(S.task)}</textarea>
    <div class="ck-form-row">
      <label class="ck-field">Profile
        <select id="ck-profile">
          <option value="">(project default${proj.profile ? ` · ${esc(proj.profile)}` : ''})</option>
          ${S.profiles.map((p) => `<option value="${esc(p)}" ${p === S.profile ? 'selected' : ''}>${esc(p)}</option>`).join('')}
        </select>
      </label>
      <label class="ck-field ck-check">
        <input type="checkbox" id="ck-hermes" ${S.viaHermes ? 'checked' : ''} ${S.mode !== 'quick' ? 'disabled' : ''}>
        via-Hermes${S.mode !== 'quick' ? ' (quick only)' : ''}</label>
    </div>
    <div class="ck-modes">
      ${modes.map((m) => `<label class="ck-mode ${S.mode === m ? 'active' : ''}">
        <input type="radio" name="ck-mode" value="${m}" ${S.mode === m ? 'checked' : ''}>
        <span class="ck-mode-name">${m[0].toUpperCase() + m.slice(1)}</span>
        <span class="ck-mode-hint">${MODE_HELP[m]}</span></label>`).join('')}
    </div>
    <div class="ck-actions">
      <button id="ck-draft" class="ck-btn primary" ${S.drafting ? 'disabled' : ''}>
        ${S.drafting ? '<span class="ck-spin"></span> Drafting…' : `Draft ${ic('arrow')}`}</button>
      ${S.draftResult ? '<button id="ck-reset" class="ck-btn ghost">Reset</button>' : ''}
    </div>
    <div id="ck-draft-result"></div>`;

  // bindings — write straight into JS state so a poll re-render never clobbers
  el.querySelector('#ck-task').addEventListener('input', (e) => { S.task = e.target.value; });
  el.querySelector('#ck-profile').addEventListener('change', (e) => { S.profile = e.target.value; });
  el.querySelector('#ck-hermes').addEventListener('change', (e) => { S.viaHermes = e.target.checked; });
  el.querySelectorAll('input[name="ck-mode"]').forEach((r) =>
    r.addEventListener('change', (e) => { S.mode = e.target.value; if (S.mode !== 'quick') S.viaHermes = false; renderSpawn(); }));
  el.querySelector('#ck-draft').addEventListener('click', doDraft);
  const reset = el.querySelector('#ck-reset');
  if (reset) reset.addEventListener('click', () => { S.draftResult = null; S.editedPrompt = ''; renderSpawn(); });
  renderDraftResult();
}

function renderDraftResult() {
  const el = document.querySelector('#aios-cockpit-modal #ck-draft-result');
  if (!el) return;
  const res = S.draftResult;
  if (!res) { el.innerHTML = ''; return; }
  if (!res.ok) {
    el.innerHTML = `<div class="ck-error"><strong>Drafter failed.</strong>
      <pre>${esc(res.error || res.stderr || 'unknown error')}</pre></div>`;
    return;
  }
  const brief = S.brief;
  const queued = brief && S.briefQueue.length
    ? `<p class="ck-muted" style="margin:4px 0 0;">+${S.briefQueue.length} more task${S.briefQueue.length > 1 ? 's' : ''} queued from this brief — load them after this one spawns.</p>`
    : '';
  const label = brief
    ? 'Grilled brief (egress-approved — edit before evaluating)'
    : 'Claude prompt (edit before spawn)';
  const actions = brief
    ? `<button id="ck-evaluate" class="ck-btn primary" ${S.spawning ? 'disabled' : ''}>
         ${S.spawning ? 'Starting…' : `Evaluate (Opus plan) ${ic('brain')}`}</button>
       <button id="ck-spawn" class="ck-btn ghost" ${S.spawning ? 'disabled' : ''}>Spawn directly</button>`
    : `<button id="ck-spawn" class="ck-btn primary" ${S.spawning ? 'disabled' : ''}>
         ${S.spawning ? 'Spawning…' : 'Spawn'}</button>`;
  el.innerHTML = `
    ${brief ? '<p class="ck-muted" style="margin:0 0 6px;">Opus reviews this brief in <strong>plan mode</strong> (read-only) before any code is written.</p>' : ''}
    <label class="ck-field">${label}
      <textarea id="ck-edited" rows="9">${esc(S.editedPrompt)}</textarea></label>
    ${queued}
    <div class="ck-actions">${actions}</div>
    <div id="ck-spawn-result" class="ck-muted"></div>`;
  el.querySelector('#ck-edited').addEventListener('input', (e) => { S.editedPrompt = e.target.value; });
  el.querySelector('#ck-spawn').addEventListener('click', doSpawn);
  const ev = el.querySelector('#ck-evaluate');
  if (ev) ev.addEventListener('click', doEvaluatePlan);
}

function renderWork() {
  const el = document.querySelector('#aios-cockpit-modal #ck-work');
  if (!el) return;
  if (!S.selectedSlug) { el.innerHTML = ''; return; }
  const { active, recent } = runsForSlug(S.selectedSlug);
  const row = (r, isActive) => `
    <button class="ck-run ${r.id === S.selectedRunId ? 'sel' : ''}" data-run="${esc(r.id)}">
      <span class="ck-run-dot ${isActive ? 'live' : esc(r.status || '')}"></span>
      <code class="ck-run-id">${esc(r.short_id || r.id)}</code>
      ${r.profile ? `<span class="ck-run-prof">${esc(r.profile)}</span>` : ''}
      <span class="ck-muted">${fmtAge(r.age_sec)}</span>
      <span class="ck-run-task">${esc((r.task || '').slice(0, 80))}</span>
    </button>`;
  el.innerHTML = `
    <h4 class="ck-work-h">Work ${active.length ? `<span class="ck-badge live"><span class="ck-dot"></span>${active.length}</span>` : ''}</h4>
    ${active.length ? active.map((r) => row(r, true)).join('') : '<p class="ck-muted ck-empty">No active runs — draft a task to begin.</p>'}
    ${recent.length ? `<h5 class="ck-work-sub">Recent</h5>${recent.slice(0, 8).map((r) => row(r, false)).join('')}` : ''}`;
  el.querySelectorAll('.ck-run').forEach((b) =>
    b.addEventListener('click', () => selectRun(b.dataset.run)));
}

async function renderDetail() {
  const el = document.querySelector('#aios-cockpit-modal #ck-detail');
  if (!el) return;
  if (!S.selectedRunId) {
    el.innerHTML = '<p class="ck-muted ck-detail-empty">Select a run to see output, changes, and actions.</p>';
    return;
  }
  const rid = S.selectedRunId;
  const isPlanRun = S.planRunId && rid === S.planRunId;
  const planBar = isPlanRun
    ? `<div class="ck-plan-bar">
         <span class="ck-muted">Opus plan-mode review (read-only). Approve to spawn the implementation run.</span>
         <span style="flex:1"></span>
         <button id="ck-revise-brief" class="ck-btn ghost sm">Revise brief</button>
         <button id="ck-approve-plan" class="ck-btn primary sm">${ic('play')} Approve plan → implement</button>
       </div>`
    : '';
  el.innerHTML = `
    <div class="ck-detail-head">
      <code class="ck-run-id">${esc(rid)}</code>
      <span style="flex:1"></span>
      <button id="ck-follow" class="ck-btn ghost sm">${ic('play')} Follow</button>
      <button id="ck-pr" class="ck-btn ghost sm">${ic('branch')} PR</button>
      <button id="ck-cancel" class="ck-btn danger sm">${ic('cancel')} Cancel</button>
    </div>
    ${planBar}
    <div class="ck-detail-tabs">
      <button class="ck-dtab ${S.detailTab === 'output' ? 'active' : ''}" data-dt="output">Output</button>
      <button class="ck-dtab ${S.detailTab === 'changes' ? 'active' : ''}" data-dt="changes">Changes</button>
    </div>
    <div id="ck-detail-body" class="ck-detail-body"><p class="ck-muted">Loading…</p></div>`;
  el.querySelector('#ck-follow').addEventListener('click', () => openRunTerminal(rid));
  el.querySelector('#ck-pr').addEventListener('click', () => doBackfillPr(rid));
  el.querySelector('#ck-cancel').addEventListener('click', () => doCancel(rid));
  const approve = el.querySelector('#ck-approve-plan');
  if (approve) approve.addEventListener('click', doImplement);
  const revise = el.querySelector('#ck-revise-brief');
  if (revise) revise.addEventListener('click', () => { S.selectedRunId = null; S.detailTab = 'output'; renderWork(); renderDetail(); renderSpawn(); });
  el.querySelectorAll('.ck-dtab').forEach((b) =>
    b.addEventListener('click', () => { S.detailTab = b.dataset.dt; renderDetail(); }));
  renderDetailBody();
}

async function renderDetailBody() {
  const el = document.querySelector('#aios-cockpit-modal #ck-detail-body');
  if (!el) return;
  const rid = S.selectedRunId;
  if (S.detailTab === 'output') {
    const d = await aiosGet(`/runs/${encodeURIComponent(rid)}/output`);
    if (S.selectedRunId !== rid) return;   // selection changed mid-fetch
    if (d && d.ok) el.innerHTML = `<pre class="ck-pre">${esc(d.last_output || '(no output yet)')}</pre>`;
    else el.innerHTML = `<p class="ck-muted">${esc((d && d.error) || 'no output')}</p>`;
  } else {
    const d = await aiosGet(`/runs/${encodeURIComponent(rid)}/diff`);
    if (S.selectedRunId !== rid) return;
    if (d && d.ok) {
      el.innerHTML = `
        <div class="ck-diff-meta">branch <code>${esc(d.branch)}</code> vs <code>${esc(d.base)}</code>
          ${d.truncated ? '<span class="ck-muted">· truncated</span>' : ''}</div>
        <pre class="ck-pre ck-diff">${esc(d.diff || '(no changes)')}</pre>`;
    } else {
      el.innerHTML = `<p class="ck-muted">${esc((d && d.error) || 'no diff available')}</p>`;
    }
  }
}

// ── Actions ────────────────────────────────────────────────────────────────
function selectProject(slug) {
  if (S.selectedSlug === slug) return;
  S.selectedSlug = slug;
  S.selectedRunId = null;
  S.draftResult = null; S.editedPrompt = '';
  const proj = S.projects.find((p) => p.slug === slug);
  S.profile = (proj && proj.profile && S.profiles.includes(proj.profile)) ? proj.profile : '';
  renderRail(); renderSpawn(); renderWork(); renderDetail();
}

function selectRun(rid) {
  S.selectedRunId = rid;
  S.detailTab = 'output';
  renderWork(); renderDetail();
}

async function doDraft() {
  if (S.drafting || !S.selectedSlug || !S.task.trim()) return;
  S.drafting = true; S.draftResult = null; renderSpawn();
  const res = await aiosPost('/brief/draft', {
    slug: S.selectedSlug, task: S.task, mode: S.mode,
    profile: S.profile || null, via_hermes: S.viaHermes,
  });
  S.drafting = false;
  S.draftResult = res || { ok: false, error: 'no response' };
  if (res && res.ok) S.editedPrompt = extractDraftPrompt(res.output || '');
  renderSpawn();
}

async function doSpawn() {
  if (S.spawning || !S.selectedSlug || !S.editedPrompt.trim()) return;
  S.spawning = true; renderDraftResult();
  const res = await aiosPost('/brief/spawn', {
    slug: S.selectedSlug, prompt: S.editedPrompt,
    profile: S.profile || null, drafter_mode: S.mode,
  });
  S.spawning = false;
  const out = document.querySelector('#aios-cockpit-modal #ck-spawn-result');
  if (res && res.ok) {
    if (out) out.innerHTML = `<span class="ck-ok">spawned</span> <code>${esc(res.run_id || '')}</code>`;
    S.task = ''; S.draftResult = null; S.editedPrompt = '';
    await loadRuns(); renderRail(); renderWork();
    setTimeout(() => { renderSpawn(); }, 1200);
  } else if (out) {
    out.innerHTML = `<span class="ck-err">spawn failed: ${esc((res && (res.error || JSON.stringify(res))) || 'unknown')}</span>`;
  }
}

// ── /grill-me handoff: brief → Opus plan-mode evaluation → implement ────────
// Pre-fill the spawn area from an egress-approved grilled brief. Lands in the
// post-draft slot (editedPrompt + draftResult) so the drafter is bypassed — the
// brief is already drafted and scrubbed; re-drafting would paraphrase it.
export async function openWorkshopWithBrief(brief) {
  if (!S.open) { await openCockpit(); } else { switchTab('workshop'); }
  if (!S.open) return;
  applyBrief(brief || {});
}

function applyBrief({ parsed, scrubbed } = {}) {
  parsed = parsed || {};
  const slug = parsed.project_slug || '';
  if (slug && S.projects.find((p) => p.slug === slug)) selectProject(slug);
  if (parsed.suggested_profile && S.profiles.includes(parsed.suggested_profile)) {
    S.profile = parsed.suggested_profile;
  }
  if (['quick', 'think', 'ensemble'].includes(parsed.suggested_mode)) S.mode = parsed.suggested_mode;
  if (S.mode !== 'quick') S.viaHermes = false;
  S.task = parsed.title || '';
  S.editedPrompt = scrubbed || '';
  S.draftResult = { ok: true, output: '' };   // mark "drafted" so Spawn/Evaluate is live
  S.brief = parsed;
  S.briefScrubbed = scrubbed || '';
  S.briefQueue = Array.isArray(parsed.suggested_decomposition) ? parsed.suggested_decomposition.slice(1) : [];
  S.planRunId = null;
  S.selectedRunId = null;
  renderSpawn(); renderWork(); renderDetail();
}

const PLAN_EVAL_PREAMBLE =
  'You are reviewing an implementation brief produced by a local intake model.\n' +
  'Evaluate it IN PLAN MODE: judge feasibility, surface risks and ambiguities, and produce a\n' +
  'concrete, ordered implementation plan. DO NOT write or edit any code — planning only.\n\n' +
  '=== BRIEF ===\n';

async function doEvaluatePlan() {
  if (S.spawning || !S.selectedSlug || !S.editedPrompt.trim()) return;
  S.spawning = true; renderDraftResult();
  const res = await aiosPost('/brief/spawn', {
    slug: S.selectedSlug,
    prompt: PLAN_EVAL_PREAMBLE + S.editedPrompt,
    profile: S.profile || null,
    permission_mode: 'plan',
    model: 'opus',
  });
  S.spawning = false;
  const out = document.querySelector('#aios-cockpit-modal #ck-spawn-result');
  if (res && res.ok) {
    S.planRunId = res.run_id || null;
    if (out) out.innerHTML = `<span class="ck-ok">Opus plan run started</span> <code>${esc(res.run_id || '')}</code> — watch it below, then approve to implement.`;
    await loadRuns(); renderRail(); renderWork();
    if (S.planRunId) selectRun(S.planRunId);
  } else if (out) {
    out.innerHTML = `<span class="ck-err">plan eval failed: ${esc((res && (res.error || JSON.stringify(res))) || 'unknown')}</span>`;
  }
}

async function doImplement() {
  if (!S.selectedSlug || !S.briefScrubbed) return;
  let planText = '';
  if (S.planRunId) {
    const d = await aiosGet(`/runs/${encodeURIComponent(S.planRunId)}/output`);
    if (d && d.ok) planText = d.last_output || '';
  }
  const prompt = S.briefScrubbed +
    (planText ? '\n\n## Approved implementation plan (from Opus review)\n' + planText : '');
  const res = await aiosPost('/brief/spawn', {
    slug: S.selectedSlug, prompt,
    profile: S.profile || null, drafter_mode: S.mode,
  });
  if (res && res.ok) {
    S.brief = null; S.briefScrubbed = ''; S.planRunId = null;
    S.draftResult = null; S.editedPrompt = ''; S.task = '';
    await loadRuns(); renderRail(); renderWork();
    if (res.run_id) selectRun(res.run_id);
    renderSpawn();
  } else {
    alert('Implementation spawn failed: ' + ((res && (res.error || JSON.stringify(res))) || 'unknown'));
  }
}

async function doCancel(rid) {
  if (!confirm(`Cancel run ${rid}? Sends SIGTERM.`)) return;
  await aiosPost(`/runs/${encodeURIComponent(rid)}/cancel`, {});
  await loadRuns(); renderRail(); renderWork();
}

async function doBackfillPr(rid) {
  const res = await aiosPost(`/runs/${encodeURIComponent(rid)}/backfill-pr`, {});
  const url = res && res.pr_url;
  alert(url ? `PR: ${url}` : `No PR found${res && res.error ? ` (${res.error})` : ''}.`);
}

// ── Tabs + poll ────────────────────────────────────────────────────────────
function switchTab(tab) {
  S.tab = tab;
  const m = document.getElementById('aios-cockpit-modal');
  if (!m) return;
  m.querySelectorAll('.ck-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  m.querySelector('#ck-workshop').style.display = tab === 'workshop' ? '' : 'none';
  m.querySelector('#ck-board').style.display = tab === 'board' ? '' : 'none';
}

async function poll() {
  await Promise.all([loadRuns(), loadDecisions()]);
  if (!S.open) return;
  renderRail(); renderWork(); renderDecisions();
}

// ── Lifecycle ──────────────────────────────────────────────────────────────
export async function openCockpit() {
  if (S.open) { closeCockpit(); return; }
  S.open = true;

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.id = 'aios-cockpit-modal';
  modal.innerHTML = `
    <div class="modal-content ck-modal-content">
      <div class="modal-header ck-head">
        <div class="ck-tabs">
          <button class="ck-tab active" data-tab="workshop">Workshop</button>
          <button class="ck-tab" data-tab="board">Board</button>
        </div>
        <div id="ck-decisions" class="ck-decisions"></div>
        <span style="flex:1"></span>
        <button class="ck-btn ghost sm" id="ck-classic" title="Roster / Org / Inbox — the old glance views">${ic('grid')} Classic views</button>
        <button class="ck-iconbtn" id="ck-close" title="Close" aria-label="Close">${ic('close')}</button>
      </div>
      <div class="modal-body ck-body">
        <div id="ck-workshop" class="ck-workshop">
          <div id="ck-rail" class="ck-rail"></div>
          <div class="ck-center">
            <div id="ck-spawn" class="ck-spawn"></div>
            <div id="ck-work" class="ck-work"></div>
          </div>
          <div id="ck-detail" class="ck-detail"></div>
        </div>
        <div id="ck-board" class="ck-board" style="display:none;">
          <p class="ck-muted" style="padding:20px;">The Issues / Done / Proposals board lands in Phase B.</p>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  document.getElementById('ck-close').addEventListener('click', closeCockpit);
  document.getElementById('ck-classic').addEventListener('click', () => agentsHubModule.openAgentsHub());
  modal.addEventListener('click', (e) => { if (e.target === modal) closeCockpit(); });
  S.escHandler = (e) => { if (e.key === 'Escape') closeCockpit(); };
  document.addEventListener('keydown', S.escHandler);
  modal.querySelectorAll('.ck-tab').forEach((b) =>
    b.addEventListener('click', () => switchTab(b.dataset.tab)));

  document.querySelector('#aios-cockpit-modal #ck-rail').innerHTML = '<p class="ck-muted">Loading…</p>';
  await Promise.all([loadProjects(), loadProfiles(), loadRuns(), loadDecisions()]);
  if (!S.open) return;
  renderDecisions(); renderRail(); renderSpawn(); renderWork(); renderDetail();
  S.pollTimer = setInterval(poll, 5000);
}

export function closeCockpit() {
  if (!S.open) return;
  S.open = false;
  if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; }
  if (S.escHandler) { document.removeEventListener('keydown', S.escHandler); S.escHandler = null; }
  const modal = document.getElementById('aios-cockpit-modal');
  if (modal) {
    const content = modal.querySelector('.modal-content');
    if (content) {
      content.classList.add('modal-closing');
      content.addEventListener('animationend', () => modal.remove(), { once: true });
      setTimeout(() => { if (modal.parentElement) modal.remove(); }, 250);
    } else { modal.remove(); }
  }
}

export function isCockpitOpen() { return S.open; }
export default { openCockpit, closeCockpit, isCockpitOpen, openWorkshopWithBrief };
