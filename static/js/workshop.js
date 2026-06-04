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
import { ic } from './icons.js';
import { styledConfirm, styledAlert } from './ui.js';
import { openRunTerminal } from './runTerminal.js';
import agentsHubModule from './agentsHub.js';
import boardModule from './board.js';
import inboxTabModule from './inboxTab.js';
import schedulesModule from './schedules.js';

const MODE_HELP = {
  quick: 'Sonnet 4.6 · ~$0.003 · ~10s',
  think: 'Opus + thinking · ~$0.05 · ~20s',
  ensemble: 'Sonnet + Hermes → Opus · ~$0.10 · ~30s',
};

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
  // ── Manager-brain (Phase C, §5) ──────────────────────────────────────────
  path: 'direct',               // 'direct' | 'brain' — the spawn-area mode
  brainMode: 'plan',            // 'plan' (decompose→approve) | 'orchestrate' (delegate+digest)
  manager: null,                // {manager, domain, manages:[{name,profile,description}], ...}
  managerLoading: false,
  managerRunId: null,           // the brain's planning/orchestration run
  brainAsking: false,
  plan: null,                   // parsed [{profile,title,prompt}] from the brain's plan
  planError: '',                // parse/exec error surfaced under the planning area
  planApproving: false,
  planFileIssues: true,         // also file each approved subtask as an issue
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

// ── Manager-brain plan parser (Phase C) ────────────────────────────────────
// The brain emits a fenced ```json array of [{profile,title,prompt}]. Pull the
// last valid JSON array out of the run output (prefer a fenced block; fall back
// to the last bare [...]). Pure → unit-tested.
function _tryParsePlanArray(s) {
  const str = String(s || '');
  const a = str.indexOf('['); const b = str.lastIndexOf(']');
  if (a === -1 || b === -1 || b < a) return null;
  try {
    const parsed = JSON.parse(str.slice(a, b + 1));
    if (Array.isArray(parsed) && parsed.length &&
        parsed.every((x) => x && typeof x === 'object' && (x.prompt || x.title))) {
      return parsed.map((x) => ({
        profile: String(x.profile || ''), title: String(x.title || ''), prompt: String(x.prompt || ''),
      }));
    }
  } catch { /* not this candidate */ }
  return null;
}
export function extractPlan(text) {
  const t = String(text || '');
  const fences = [...t.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((f) => f[1]);
  for (let i = fences.length - 1; i >= 0; i--) {
    const arr = _tryParsePlanArray(fences[i]);
    if (arr) return arr;
  }
  return _tryParsePlanArray(t);   // bare-array fallback
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
  // Phase B: the board module owns the issues/proposals/questions fetch (one
  // pass) and returns the three actionable counts for the Decisions strip —
  // in_review issues ready to merge · Hermes proposals · open escalations.
  const counts = await boardModule.loadBoard();
  if (counts) S.decisions = counts;
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
  // A pre-filled /grill-me brief is always a direct launch (its prompt is already
  // drafted + egress-approved); never offer the brain path over it.
  const brainAvailable = !S.brief;
  el.innerHTML = `
    <div class="ck-proj-head">
      <div>
        <div class="ck-eyebrow">${esc(proj.category || 'project')}</div>
        <h2 class="ck-proj-title">${esc(proj.slug)}</h2>
      </div>
    </div>
    ${brainAvailable ? `<div class="ck-launch-paths">
      <label class="ck-seg ${S.path === 'direct' ? 'active' : ''}"><input type="radio" name="ck-path" value="direct" ${S.path === 'direct' ? 'checked' : ''}>
        ${ic('bolt')}<span>Direct launch</span></label>
      <label class="ck-seg ${S.path === 'brain' ? 'active' : ''}"><input type="radio" name="ck-path" value="brain" ${S.path === 'brain' ? 'checked' : ''}>
        ${ic('brain')}<span>Ask the brain</span></label>
    </div>` : ''}
    <div id="ck-path-body"></div>`;

  if (brainAvailable) {
    el.querySelectorAll('input[name="ck-path"]').forEach((r) =>
      r.addEventListener('change', (e) => {
        S.path = e.target.value;
        if (S.path === 'brain' && !S.manager && !S.managerLoading) loadManager();
        renderSpawn();
      }));
  }
  if (brainAvailable && S.path === 'brain') renderBrain(); else renderDirect();
}

function renderDirect() {
  const el = document.querySelector('#aios-cockpit-modal #ck-path-body');
  if (!el) return;
  const proj = S.projects.find((p) => p.slug === S.selectedSlug);
  const modes = ['quick', 'think', 'ensemble'];
  el.innerHTML = `
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

  el.querySelector('#ck-task').addEventListener('input', (e) => { S.task = e.target.value; });
  el.querySelector('#ck-profile').addEventListener('change', (e) => { S.profile = e.target.value; });
  el.querySelector('#ck-hermes').addEventListener('change', (e) => { S.viaHermes = e.target.checked; });
  el.querySelectorAll('input[name="ck-mode"]').forEach((r) =>
    r.addEventListener('change', (e) => { S.mode = e.target.value; if (S.mode !== 'quick') S.viaHermes = false; renderDirect(); }));
  el.querySelector('#ck-draft').addEventListener('click', doDraft);
  const reset = el.querySelector('#ck-reset');
  if (reset) reset.addEventListener('click', () => { S.draftResult = null; S.editedPrompt = ''; renderDirect(); });
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

// ── Ask the brain (manager) — §5 ────────────────────────────────────────────
function brainRole(m) {
  return `You are the ${m.manager.toUpperCase()}, the ${m.domain} domain brain in `
    + `diego's "company of AIs". You PLAN and DELEGATE; you do NOT do specialist work `
    + `yourself. You are running inside the project's own directory (read it freely).\n`
    + `Specialists you manage:\n`
    + m.manages.map((s) => `- ${s.name} (profile ${s.profile}): ${s.description || '(no description)'}`).join('\n');
}
function buildPlanPrompt(m, proj, intent) {
  return `${brainRole(m)}\n\nProject: ${proj.slug} · category ${proj.category || '?'}\n\n`
    + `diego's intent:\n${intent}\n\n`
    + `PLAN ONLY — do NOT spawn, edit, run, or delegate anything. Decompose the intent `
    + `into the SMALLEST set of specialist subtasks that accomplishes it. For each, write a `
    + `complete, self-contained engineered prompt the specialist can execute without further context.\n\n`
    + `Output ONLY a single fenced \`\`\`json code block — an array ordered by execution order:\n`
    + `[{"profile": "<one of: ${m.manages.map((s) => s.name).join(', ')}>", "title": "<short label>", `
    + `"prompt": "<full engineered prompt>"}]\n`
    + `No prose outside the code block. Keep it minimal — only genuinely needed subtasks.`;
}
function buildOrchestratePrompt(m, proj, intent) {
  return `${brainRole(m)}\n\nProject: ${proj.slug} · category ${proj.category || '?'}\n\n`
    + `diego's intent:\n${intent}\n\n`
    + `Use \`aios-delegate\` to dispatch the needed specialists for this intent (one delegation `
    + `per subtask), then write a short digest of what you delegated and why. Keep it cheap — `
    + `delegate only genuinely needed work.`;
}

async function loadManager() {
  if (!S.selectedSlug) return;
  S.managerLoading = true;
  if (S.path === 'brain') renderBrain();
  const d = await aiosGet(`/projects/${encodeURIComponent(S.selectedSlug)}/manager`);
  S.manager = (d && !d.error && d.manager) ? d : null;
  S.managerLoading = false;
  if (S.path === 'brain') renderBrain();
}

function renderBrain() {
  const el = document.querySelector('#aios-cockpit-modal #ck-path-body');
  if (!el) return;
  const m = S.manager;
  const ident = S.managerLoading
    ? '<p class="ck-muted">Resolving the domain brain…</p>'
    : m ? `<div class="ck-brain-id">
        <span class="ck-brain-badge">${ic('brain')} ${esc(m.manager.toUpperCase())}</span>
        <span class="ck-muted">domain <strong>${esc(m.domain)}</strong> · manages
          ${m.manages.map((s) => `<span class="ck-run-prof" title="${esc(s.description || '')}">${esc(s.name)}</span>`).join(' ')}</span>
      </div>`
      : '<p class="ck-muted">No brain resolved for this project.</p>';
  const brainName = m ? esc(m.manager.toUpperCase()) : 'brain';
  el.innerHTML = `
    ${ident}
    <textarea id="ck-brain-task" rows="3" placeholder="intent for the ${brainName} — what should the team accomplish?">${esc(S.task)}</textarea>
    <div class="ck-modes ck-brain-modes">
      <label class="ck-mode ${S.brainMode === 'plan' ? 'active' : ''}"><input type="radio" name="ck-brainmode" value="plan" ${S.brainMode === 'plan' ? 'checked' : ''}>
        <span class="ck-mode-name">Plan</span><span class="ck-mode-hint">Decompose → you approve → spawn children. Read-only planning.</span></label>
      <label class="ck-mode ${S.brainMode === 'orchestrate' ? 'active' : ''}"><input type="radio" name="ck-brainmode" value="orchestrate" ${S.brainMode === 'orchestrate' ? 'checked' : ''}>
        <span class="ck-mode-name">Orchestrate</span><span class="ck-mode-hint">Brain delegates via aios-delegate + writes a digest. It spawns.</span></label>
    </div>
    <div class="ck-actions">
      <button id="ck-ask-brain" class="ck-btn primary" ${S.brainAsking || !m ? 'disabled' : ''}>
        ${S.brainAsking ? '<span class="ck-spin"></span> Asking…' : `Ask ${brainName} ${ic('arrow')}`}</button>
      ${(S.managerRunId || S.plan) ? '<button id="ck-brain-reset" class="ck-btn ghost">Reset</button>' : ''}
    </div>
    <div id="ck-brain-result"></div>`;
  el.querySelector('#ck-brain-task').addEventListener('input', (e) => { S.task = e.target.value; });
  el.querySelectorAll('input[name="ck-brainmode"]').forEach((r) =>
    r.addEventListener('change', (e) => { S.brainMode = e.target.value; renderBrain(); }));
  const ask = el.querySelector('#ck-ask-brain');
  if (ask) ask.addEventListener('click', doAskBrain);
  const reset = el.querySelector('#ck-brain-reset');
  if (reset) reset.addEventListener('click', resetBrain);
  renderBrainResult();
}

function renderBrainResult() {
  const el = document.querySelector('#aios-cockpit-modal #ck-brain-result');
  if (!el) return;
  const brainName = esc(S.manager ? S.manager.manager.toUpperCase() : 'Brain');
  if (S.brainMode === 'orchestrate' && S.managerRunId) {
    el.innerHTML = `<div class="ck-plan-note">${ic('brain')} ${brainName} is orchestrating in
      <code>${esc(S.managerRunId)}</code> — watch it in the run detail; its delegated child runs
      aggregate under the <strong>Children</strong> tab there as they spawn.</div>`;
    return;
  }
  if (S.planError) { el.innerHTML = `<div class="ck-error"><strong>Plan unavailable.</strong> <pre>${esc(S.planError)}</pre></div>`; return; }
  if (S.managerRunId && !S.plan) {
    el.innerHTML = `<div class="ck-plan-note"><span class="ck-spin"></span> ${brainName} is planning in
      <code>${esc(S.managerRunId)}</code> — parsing its subtasks when ready…</div>`;
    return;
  }
  if (!S.plan) { el.innerHTML = ''; return; }
  const cards = S.plan.map((t, i) => `<div class="ck-subtask" data-i="${i}">
      <div class="ck-subtask-head">
        <span class="ck-run-prof">${esc(t.profile || '?')}</span>
        <input class="ck-subtask-title" data-i="${i}" value="${esc(t.title || '')}">
        <button class="ck-iconbtn ck-subtask-del" data-i="${i}" title="Drop subtask">${ic('close')}</button>
      </div>
      <textarea class="ck-subtask-prompt" data-i="${i}" rows="4">${esc(t.prompt || '')}</textarea>
    </div>`).join('');
  el.innerHTML = `
    <div class="ck-plan-head"><strong>${S.plan.length} subtask${S.plan.length !== 1 ? 's' : ''}</strong> — edit, drop, then approve to spawn as children of the brain run.</div>
    ${cards}
    <label class="ck-field ck-check"><input type="checkbox" id="ck-plan-issues" ${S.planFileIssues ? 'checked' : ''}> also file each as an issue</label>
    <div class="ck-actions">
      <button id="ck-approve-subtasks" class="ck-btn primary" ${S.planApproving ? 'disabled' : ''}>
        ${S.planApproving ? '<span class="ck-spin"></span> Spawning…' : `${ic('play')} Approve → spawn ${S.plan.length} child run${S.plan.length !== 1 ? 's' : ''}`}</button>
    </div>
    <div id="ck-plan-spawn-result" class="ck-muted"></div>`;
  el.querySelectorAll('.ck-subtask-title').forEach((t) =>
    t.addEventListener('input', (e) => { S.plan[+e.target.dataset.i].title = e.target.value; }));
  el.querySelectorAll('.ck-subtask-prompt').forEach((t) =>
    t.addEventListener('input', (e) => { S.plan[+e.target.dataset.i].prompt = e.target.value; }));
  el.querySelectorAll('.ck-subtask-del').forEach((b) =>
    b.addEventListener('click', () => { S.plan.splice(+b.dataset.i, 1); renderBrainResult(); }));
  el.querySelector('#ck-plan-issues').addEventListener('change', (e) => { S.planFileIssues = e.target.checked; });
  el.querySelector('#ck-approve-subtasks').addEventListener('click', doApprovePlan);
}

async function doAskBrain() {
  if (S.brainAsking || !S.manager || !S.task.trim()) return;
  S.brainAsking = true; S.plan = null; S.planError = ''; S.managerRunId = null;
  renderBrain();
  const proj = S.projects.find((p) => p.slug === S.selectedSlug);
  const m = S.manager;
  const isPlan = S.brainMode === 'plan';
  const prompt = isPlan ? buildPlanPrompt(m, proj, S.task) : buildOrchestratePrompt(m, proj, S.task);
  const body = { slug: S.selectedSlug, prompt, profile: 'manager', agent_name: m.manager };
  if (isPlan) body.permission_mode = 'plan';   // enforce read-only planning
  const res = await aiosPost('/brief/spawn', body);
  S.brainAsking = false;
  if (res && res.ok) {
    S.managerRunId = res.run_id || null;
    await loadRuns(); renderRail(); renderWork();
    if (S.managerRunId) selectRun(S.managerRunId);
    renderBrain();
  } else {
    S.planError = (res && (res.error || JSON.stringify(res))) || 'spawn failed';
    renderBrain();
  }
}

// Polled from poll(): while the brain's plan run is live, try to parse its output.
async function pollBrainPlan() {
  if (!(S.managerRunId && !S.plan && !S.planError && S.brainMode === 'plan')) return;
  const d = await aiosGet(`/runs/${encodeURIComponent(S.managerRunId)}/output`);
  if (!(d && d.ok)) return;
  const plan = extractPlan(d.last_output || '');
  if (plan) {
    S.plan = plan;
    if (S.path === 'brain') renderBrain();
    return;
  }
  const run = [...S.activeRuns, ...S.recentRuns].find((r) => r.id === S.managerRunId);
  if (run && ['completed', 'failed', 'cancelled'].includes(run.status)) {
    S.planError = 'The brain finished but emitted no parseable JSON plan. Open its run output to inspect.';
    if (S.path === 'brain') renderBrain();
  }
}

async function doApprovePlan() {
  if (S.planApproving || !S.plan || !S.plan.length || !S.managerRunId) return;
  S.planApproving = true; renderBrainResult();
  const out = () => document.querySelector('#aios-cockpit-modal #ck-plan-spawn-result');
  let ok = 0; let fail = 0;
  for (const t of S.plan) {
    if (!t.prompt.trim()) { fail++; continue; }
    const res = await aiosPost('/brief/spawn', {
      slug: S.selectedSlug, prompt: t.prompt, profile: t.profile || null,
      parent_run_id: S.managerRunId, thread_id: S.managerRunId,
    });
    if (res && res.ok) {
      ok++;
      if (S.planFileIssues) {
        await aiosPost('/issues', {
          title: (t.title || t.prompt.slice(0, 60)).trim(),
          assignee: t.profile || null,
          created_by: S.manager ? S.manager.manager : 'manager',
          status: 'in_progress',
        });
      }
    } else { fail++; }
    if (out()) out().innerHTML = `spawning… ${ok} ok${fail ? `, ${fail} failed` : ''}`;
  }
  S.planApproving = false;
  await loadRuns(); renderRail(); renderWork();
  loadDecisions().then(renderDecisions);
  if (out()) out().innerHTML = `<span class="ck-ok">${ok} child run${ok !== 1 ? 's' : ''} spawned</span>${fail ? ` · <span class="ck-err">${fail} failed</span>` : ''} — threaded under the brain run.`;
}

function resetBrain() {
  S.managerRunId = null; S.plan = null; S.planError = '';
  S.brainAsking = false; S.planApproving = false; S.task = '';
  renderBrain();
}

// ── WORK list (thread-grouped: manager runs nest their child specialist runs) ─
function threadGroups(runs) {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const kids = new Map();
  runs.forEach((r) => {
    const p = r.parent_run_id;
    if (p && byId.has(p)) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(r); }
  });
  const out = []; const seen = new Set();
  runs.forEach((r) => {
    if (r.parent_run_id && byId.has(r.parent_run_id)) return;   // emitted under its parent
    if (seen.has(r.id)) return; seen.add(r.id);
    out.push({ run: r, child: false });
    (kids.get(r.id) || []).forEach((c) => { if (!seen.has(c.id)) { seen.add(c.id); out.push({ run: c, child: true }); } });
  });
  return out;
}

function renderWork() {
  const el = document.querySelector('#aios-cockpit-modal #ck-work');
  if (!el) return;
  if (!S.selectedSlug) { el.innerHTML = ''; return; }
  const { active, recent } = runsForSlug(S.selectedSlug);
  const isLive = (r) => active.some((a) => a.id === r.id);
  const row = ({ run: r, child }) => `
    <button class="ck-run ${child ? 'child' : ''} ${r.id === S.selectedRunId ? 'sel' : ''}" data-run="${esc(r.id)}">
      <span class="ck-run-dot ${isLive(r) ? 'live' : esc(r.status || '')}"></span>
      <code class="ck-run-id">${esc(r.short_id || r.id)}</code>
      ${r.profile ? `<span class="ck-run-prof">${esc(r.profile)}</span>` : ''}
      <span class="ck-muted">${fmtAge(r.age_sec)}</span>
      <span class="ck-run-task">${esc((r.task || '').slice(0, 80))}</span>
    </button>`;
  // Combine active+recent so a live child nests under its (possibly finished)
  // manager parent; thread roots first, children indented beneath.
  const combined = [...active, ...recent.slice(0, 12)];
  const groups = threadGroups(combined);
  el.innerHTML = `
    <h4 class="ck-work-h">Work ${active.length ? `<span class="ck-badge live"><span class="ck-dot"></span>${active.length}</span>` : ''}</h4>
    ${groups.length ? groups.map(row).join('') : '<p class="ck-muted ck-empty">No runs yet — draft a task or ask the brain to begin.</p>'}`;
  el.querySelectorAll('.ck-run').forEach((b) =>
    b.addEventListener('click', () => selectRun(b.dataset.run)));
}

// Child runs delegated by an Orchestrate-mode manager (parent_run_id = the
// manager run). Deduped across active + recent.
function childrenOf(rid) {
  const seen = new Set(); const out = [];
  for (const r of [...S.activeRuns, ...S.recentRuns]) {
    if (r.parent_run_id === rid && !seen.has(r.id)) { seen.add(r.id); out.push(r); }
  }
  return out;
}

async function renderDetail() {
  const el = document.querySelector('#aios-cockpit-modal #ck-detail');
  if (!el) return;
  if (!S.selectedRunId) {
    el.innerHTML = '<p class="ck-muted ck-detail-empty">Select a run to see output, changes, and actions.</p>';
    return;
  }
  const rid = S.selectedRunId;
  const kids = childrenOf(rid);
  if (S.detailTab === 'children' && !kids.length) S.detailTab = 'output';
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
      ${kids.length ? `<button class="ck-dtab ${S.detailTab === 'children' ? 'active' : ''}" data-dt="children">Children <span class="ck-dtab-n">${kids.length}</span></button>` : ''}
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

function renderChildren(el, rid) {
  const kids = childrenOf(rid);
  const isLive = (r) => S.activeRuns.some((a) => a.id === r.id);
  const tally = kids.reduce((acc, r) => {
    const k = isLive(r) ? 'running' : (r.status || 'other');
    acc[k] = (acc[k] || 0) + 1; return acc;
  }, {});
  const tallyStr = Object.entries(tally).map(([k, n]) => `${n} ${k}`).join(' · ');
  const rows = kids.map((r) => `
    <button class="ck-run ${r.id === S.selectedRunId ? 'sel' : ''}" data-run="${esc(r.id)}">
      <span class="ck-run-dot ${isLive(r) ? 'live' : esc(r.status || '')}"></span>
      <code class="ck-run-id">${esc(r.short_id || r.id)}</code>
      ${r.profile ? `<span class="ck-run-prof">${esc(r.profile)}</span>` : ''}
      <span class="ck-muted">${fmtAge(r.age_sec)}</span>
      <span class="ck-run-task">${esc((r.task || '').slice(0, 80))}</span>
    </button>`).join('');
  el.innerHTML = `
    <div class="ck-children-head">
      <span class="ck-muted">Orchestration thread · ${kids.length} delegated child run${kids.length !== 1 ? 's' : ''}${tallyStr ? ` · ${esc(tallyStr)}` : ''}.</span>
      <p class="ck-muted" style="margin:4px 0 0;">Select a child to review its output &amp; changes.</p>
    </div>
    <div class="ck-children-list">${rows || '<p class="ck-muted">No child runs.</p>'}</div>`;
  el.querySelectorAll('.ck-run').forEach((b) =>
    b.addEventListener('click', () => selectRun(b.dataset.run)));
}

async function renderDetailBody() {
  const el = document.querySelector('#aios-cockpit-modal #ck-detail-body');
  if (!el) return;
  const rid = S.selectedRunId;
  if (S.detailTab === 'children') {
    renderChildren(el, rid);
    return;
  }
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
  // Reset the brain workflow for the new project; reload its manager lazily when
  // the brain path is active so the identity strip is correct.
  S.manager = null; S.managerRunId = null; S.plan = null; S.planError = '';
  S.brainAsking = false; S.planApproving = false;
  const proj = S.projects.find((p) => p.slug === slug);
  S.profile = (proj && proj.profile && S.profiles.includes(proj.profile)) ? proj.profile : '';
  renderRail(); renderSpawn(); renderWork(); renderDetail();
  if (S.path === 'brain') loadManager();
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
    await styledAlert('Implementation spawn failed: ' + ((res && (res.error || JSON.stringify(res))) || 'unknown'),
      { title: 'Spawn failed', danger: true });
  }
}

async function doCancel(rid) {
  if (!await styledConfirm(`Cancel run ${rid}? Sends SIGTERM.`, { confirmText: 'Cancel run', cancelText: 'Keep running', danger: true })) return;
  await aiosPost(`/runs/${encodeURIComponent(rid)}/cancel`, {});
  await loadRuns(); renderRail(); renderWork();
}

async function doBackfillPr(rid) {
  const res = await aiosPost(`/runs/${encodeURIComponent(rid)}/backfill-pr`, {});
  const url = res && res.pr_url;
  await styledAlert(url ? `PR: ${url}` : `No PR found${res && res.error ? ` (${res.error})` : ''}.`,
    { title: url ? 'Pull request' : 'No PR found' });
}

// ── Tabs + poll ────────────────────────────────────────────────────────────
const TAB_PANES = { workshop: '#ck-workshop', board: '#ck-board', inbox: '#ck-inbox', schedules: '#ck-schedules' };

function switchTab(tab) {
  S.tab = tab;
  const m = document.getElementById('aios-cockpit-modal');
  if (!m) return;
  m.querySelectorAll('.ck-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  Object.entries(TAB_PANES).forEach(([t, sel]) => {
    const pane = m.querySelector(sel);
    if (pane) pane.style.display = t === tab ? '' : 'none';
  });
  if (tab === 'board') boardModule.renderBoard(m.querySelector('#ck-board'));
  if (tab === 'inbox') inboxTabModule.renderInbox(m.querySelector('#ck-inbox'));
  if (tab === 'schedules') schedulesModule.renderSchedules(m.querySelector('#ck-schedules'));
}

async function poll() {
  await Promise.all([loadRuns(), loadDecisions()]);
  if (!S.open) return;
  renderRail(); renderWork(); renderDecisions();
  // While the brain's plan run is live, try parsing its output into subtasks.
  pollBrainPlan();
  // Keep the active tab fresh on the poll tick — each module keeps its editable
  // state internally, so a re-render never clobbers focus, a pane, or a draft.
  if (S.tab === 'board') {
    const bd = document.querySelector('#aios-cockpit-modal #ck-board');
    if (bd) boardModule.renderBoard(bd);
  } else if (S.tab === 'inbox') {
    const ib = document.querySelector('#aios-cockpit-modal #ck-inbox');
    if (ib) inboxTabModule.renderInbox(ib);
  } else if (S.tab === 'schedules') {
    schedulesModule.pollRefresh();
  }
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
          <button class="ck-tab" data-tab="inbox">Inbox</button>
          <button class="ck-tab" data-tab="schedules">Schedules</button>
        </div>
        <div id="ck-decisions" class="ck-decisions"></div>
        <span style="flex:1"></span>
        <button class="ck-btn ghost sm" id="ck-classic" title="New brief / Roster / Org — the glance views">${ic('grid')} Classic views</button>
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
        <div id="ck-board" class="ck-board" style="display:none;"></div>
        <div id="ck-inbox" class="ck-inbox" style="display:none;"></div>
        <div id="ck-schedules" class="ck-schedules" style="display:none;"></div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  // Board actions (status move, merge, approve, answer) resync the Decisions
  // strip immediately with the counts the board just recomputed — no refetch.
  boardModule.setOnChange((c) => { if (c) { S.decisions = c; renderDecisions(); } });
  // Inbox actions can mint issues / answer questions / merge — refresh the
  // Decisions strip (which re-derives from the board's single fetch).
  inboxTabModule.setOnChange(() => { loadDecisions().then(renderDecisions); });

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
