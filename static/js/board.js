/**
 * board.js — the Workshop cockpit's "Board" tab (COCKPIT_PROMPT §4, Phase B).
 *
 * The management heart: an Issues kanban (backlog·todo·in_progress·in_review·done,
 * blocked surfaced as a badge inside in_progress), expandable cards enriched with
 * what/why/decision/recommended_action + linked run(s)/PR, status moves via PATCH
 * (optimistic + rollback), a prominent one-tap Merge on in_review, a Done list, the
 * Hermes Proposals rail (FULL markdown detail, kind-labeled, approve/reject) and the
 * Questions (escalations) rail. Every Board item also gets an on-demand "Deep review
 * (Opus)" that returns a recommendation + plan rendered attached to the item.
 *
 * Standalone state (B) mirrors workshop.js's discipline: all editable/expanded state
 * lives in JS so a poll re-render never clobbers focus or an open pane. workshop.js
 * owns the modal + the Decisions strip; this module renders into #ck-board and reports
 * counts back via loadBoard() so the strip stays in sync.
 */
import { aiosGet, aiosPost, aiosPatch, esc } from './aiosShell.js';
import { mdToHtml } from './markdown.js';

const COLS = [
  { key: 'backlog', label: 'Backlog' },
  { key: 'todo', label: 'Todo' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'in_review', label: 'In review' },
  { key: 'done', label: 'Done' },
];

// Inline SVG icons (stroke=currentColor) — matches workshop.js's set, no emoji.
const _IC = {
  brain: '<path d="M9 3a3 3 0 0 0-3 3 3 3 0 0 0-1.5 5.6A3 3 0 0 0 6 18a3 3 0 0 0 6 .5V4.5A3 3 0 0 0 9 3z"/><path d="M15 3a3 3 0 0 1 3 3 3 3 0 0 1 1.5 5.6A3 3 0 0 1 18 18a3 3 0 0 1-6 .5"/>',
  merge: '<circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="9" r="2.4"/><path d="M6 8.4v7.2M18 11.2c0 3-4 2.6-6 4.4"/>',
  check: '<path d="M5 13l4 4L19 7"/>',
  link: '<path d="M9 15l6-6"/><path d="M11 6l1-1a4 4 0 0 1 6 6l-1 1"/><path d="M13 18l-1 1a4 4 0 0 1-6-6l1-1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};
function ic(name) {
  return `<svg class="ck-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${_IC[name] || ''}</svg>`;
}

const B = {
  loaded: false,
  issues: [],          // flat list (board columns flattened; each carries .status + .blocked)
  cancelled: [],
  statuses: COLS.map((c) => c.key),
  proposals: [],
  questions: [],
  // filters
  filter: '',
  fAssignee: '',
  fCreatedBy: '',
  // ui state (kept in JS so poll re-renders don't clobber)
  expanded: new Set(),        // issue ids expanded
  detail: {},                 // issue id -> full detail (runs/children)
  propExpanded: new Set(),    // proposal names expanded
  propDetail: {},             // name -> full markdown
  answerDraft: {},            // question id -> textarea value
  deep: {},                   // `${type}:${id}` -> {state:'loading'|'done'|'error', ...}
  showNewIssue: false,
  newIssue: { title: '', assignee: '', priority: 5, status: 'backlog', project_dir: '' },
  onChange: null,             // workshop callback to resync the Decisions strip
};

export function setOnChange(fn) { B.onChange = fn; }

function counts() {
  return {
    in_review: B.issues.filter((i) => (i.status || '') === 'in_review').length,
    proposals: B.proposals.length,
    questions: B.questions.length,
  };
}
function notifyChange() { if (B.onChange) B.onChange(counts()); }

// ── data load ───────────────────────────────────────────────────────────────
export async function loadBoard() {
  const [bd, pr, qs] = await Promise.all([
    aiosGet('/issues?board=true'),
    aiosGet('/proposals'),
    aiosGet('/questions'),
  ]);
  const cols = (bd && bd.columns) || [];
  B.issues = cols.flatMap((c) => (c.issues || []));
  B.cancelled = (bd && bd.cancelled) || [];
  if (bd && Array.isArray(bd.statuses)) B.statuses = bd.statuses;
  B.proposals = (pr && (pr.proposals || pr)) || [];
  B.questions = (qs && (qs.questions || qs)) || [];
  B.loaded = true;
  return {
    in_review: B.issues.filter((i) => (i.status || '') === 'in_review').length,
    proposals: B.proposals.length,
    questions: B.questions.length,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────
function colOf(issue) {
  const st = issue.status || 'backlog';
  if (st === 'blocked') return 'in_progress';
  return COLS.some((c) => c.key === st) ? st : 'backlog';
}
function matchesFilter(i) {
  if (B.fAssignee && (i.assignee || '') !== B.fAssignee) return false;
  if (B.fCreatedBy && (i.created_by || '') !== B.fCreatedBy) return false;
  if (B.filter) {
    const hay = `${i.id} ${i.title || ''} ${i.assignee || ''} ${i.created_by || ''}`.toLowerCase();
    if (!hay.includes(B.filter.toLowerCase())) return false;
  }
  return true;
}
function fmtDate(sec) {
  if (!sec) return '';
  const d = Math.max(0, Math.floor(Date.now() / 1000 - sec));
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)}d`;
  try { return new Date(sec * 1000).toISOString().slice(0, 10); } catch { return ''; }
}
function prioClass(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return 'p-mid';
  if (n <= 2) return 'p-hi';
  if (n <= 5) return 'p-mid';
  return 'p-lo';
}
function uniqueValues(key) {
  return [...new Set(B.issues.map((i) => i[key]).filter(Boolean))].sort();
}
function deepKey(type, id) { return `${type}:${id}`; }

// ── render ────────────────────────────────────────────────────────────────────
export function renderBoard(el) {
  if (!el) return;
  if (!B.loaded) {
    el.innerHTML = '<p class="ck-muted" style="padding:24px;">Loading board…</p>';
    loadBoard().then(() => { notifyChange(); renderBoard(el); });
    return;
  }
  el.innerHTML = `
    <div class="ck-board-bar">
      <input id="ckb-filter" class="ckb-search" placeholder="Filter issues…" value="${esc(B.filter)}">
      <select id="ckb-assignee" class="ckb-fsel">
        <option value="">All assignees</option>
        ${uniqueValues('assignee').map((v) => `<option value="${esc(v)}" ${v === B.fAssignee ? 'selected' : ''}>${esc(v)}</option>`).join('')}
      </select>
      <select id="ckb-createdby" class="ckb-fsel">
        <option value="">All delegators</option>
        ${uniqueValues('created_by').map((v) => `<option value="${esc(v)}" ${v === B.fCreatedBy ? 'selected' : ''}>${esc(v)}</option>`).join('')}
      </select>
      <span style="flex:1"></span>
      <button id="ckb-new" class="ck-btn ghost sm">${ic('plus')} New issue</button>
    </div>
    <div id="ckb-newform"></div>
    <div class="ck-kanban">
      ${COLS.map(renderColumn).join('')}
    </div>
    <div class="ck-board-rails">
      <div class="ck-rail-col">
        <h4 class="ckb-rail-h">Proposals <span class="ckb-rail-n">${B.proposals.length}</span>
          <span class="ckb-rail-sub">Hermes advisory</span></h4>
        <div id="ckb-proposals">${B.proposals.length ? B.proposals.map(renderProposal).join('') : '<p class="ck-muted ckb-empty">No pending proposals.</p>'}</div>
      </div>
      <div class="ck-rail-col">
        <h4 class="ckb-rail-h">Questions <span class="ckb-rail-n">${B.questions.length}</span>
          <span class="ckb-rail-sub">Escalations</span></h4>
        <div id="ckb-questions">${B.questions.length ? B.questions.map(renderQuestion).join('') : '<p class="ck-muted ckb-empty">No open questions.</p>'}</div>
      </div>
    </div>`;
  bindBoard(el);
}

function renderColumn(col) {
  let issues = B.issues.filter((i) => colOf(i) === col.key && matchesFilter(i));
  if (col.key === 'done') {
    issues = issues.slice().sort((a, b) => (b.resolved_at || b.updated_at || 0) - (a.resolved_at || a.updated_at || 0)).slice(0, 25);
  }
  const cards = issues.map(renderCard).join('');
  let extra = '';
  if (col.key === 'done' && B.cancelled.length) {
    const cc = B.cancelled.filter(matchesFilter);
    if (cc.length) extra = `<div class="ckb-cancelled"><span class="ckb-cancelled-h">Cancelled · ${cc.length}</span>${cc.map(renderCard).join('')}</div>`;
  }
  return `<div class="ck-kcol" data-col="${col.key}">
    <div class="ck-kcol-head"><span class="ck-kcol-label">${esc(col.label)}</span><span class="ck-kcol-n">${issues.length}</span></div>
    <div class="ck-kcol-body">${cards || '<p class="ckb-col-empty">—</p>'}${extra}</div>
  </div>`;
}

function renderCard(i) {
  const open = B.expanded.has(i.id);
  const blocked = i.status === 'blocked';
  const prChip = i.pr_url ? `<a class="ckb-chip ckb-pr" href="${esc(i.pr_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">PR</a>` : '';
  const head = `
    <div class="ckb-card-top">
      <span class="ckb-prio ${prioClass(i.priority)}" title="priority ${esc(i.priority)}">${esc(i.priority ?? '·')}</span>
      <span class="ckb-card-title">${esc(i.title || i.id)}</span>
    </div>
    <div class="ckb-card-meta">
      ${i.assignee ? `<span class="ckb-chip">${esc(i.assignee)}</span>` : ''}
      ${i.created_by ? `<span class="ckb-chip ghost">via ${esc(i.created_by)}</span>` : ''}
      ${blocked ? '<span class="ckb-chip blocked">blocked</span>' : ''}
      ${prChip}
    </div>`;
  return `<div class="ckb-card ${open ? 'open' : ''}" data-id="${esc(i.id)}">
    <div class="ckb-card-head" data-toggle="${esc(i.id)}">${head}</div>
    ${open ? renderCardBody(i) : ''}
  </div>`;
}

function renderCardBody(i) {
  const enrich = ['what', 'why', 'decision', 'recommended_action']
    .filter((k) => i[k])
    .map((k) => `<div class="ckb-enrich"><span class="ckb-enrich-k">${k.replace('_', ' ')}</span><span>${esc(i[k])}</span></div>`)
    .join('');
  const det = B.detail[i.id];
  let runs = '';
  if (det && Array.isArray(det.runs) && det.runs.length) {
    runs = `<div class="ckb-runs"><span class="ckb-enrich-k">runs</span>${det.runs.map((r) =>
      `<code class="ckb-runid">${esc(r.short_id || r.id || r.run_id || '?')}</code>`).join(' ')}</div>`;
  } else if (det === 'loading') {
    runs = '<p class="ck-muted">Loading links…</p>';
  }
  const mergeable = i.status === 'in_review';
  const opts = B.statuses.map((s) =>
    `<option value="${esc(s)}" ${s === i.status ? 'selected' : ''}>${esc(s)}</option>`).join('');
  const dk = deepKey('issue', i.id);
  return `<div class="ckb-card-body">
    ${i.description ? `<p class="ckb-desc">${esc(i.description)}</p>` : ''}
    ${enrich}
    ${runs}
    <div class="ckb-card-actions">
      <label class="ckb-move">Status
        <select class="ckb-status" data-id="${esc(i.id)}">${opts}</select></label>
      ${mergeable ? `<button class="ck-btn primary sm ckb-merge" data-id="${esc(i.id)}">${ic('merge')} Merge</button>` : ''}
      <span style="flex:1"></span>
      <button class="ck-btn ghost sm ckb-deep" data-type="issue" data-id="${esc(i.id)}">${ic('brain')} Deep review</button>
    </div>
    ${renderDeep(dk)}
  </div>`;
}

function renderProposal(p) {
  const name = p.name || p.id || '(unnamed)';
  const open = B.propExpanded.has(name);
  const dk = deepKey('proposal', name);
  let body = '';
  if (open) {
    const md = B.propDetail[name];
    body = md
      ? `<div class="aios-md ckb-prop-md">${mdToHtml(md)}</div>`
      : '<p class="ck-muted">Loading…</p>';
  } else if (p.preview) {
    body = `<p class="ckb-prop-prev">${esc(String(p.preview).slice(0, 200).trim())}…</p>`;
  }
  return `<div class="ckb-prop ${open ? 'open' : ''}" data-name="${esc(name)}">
    <div class="ckb-prop-head" data-ptoggle="${esc(name)}">
      <span class="ck-run-prof">${esc(p.kind || 'note')}</span>
      <span class="ckb-prop-name">${esc(name)}</span>
      <span class="ck-muted">${esc(fmtDate(p.mtime))}</span>
    </div>
    ${open ? `<div class="ckb-prop-body">
      ${body}
      <div class="ckb-card-actions">
        <button class="ck-btn primary sm ckb-papprove" data-name="${esc(name)}">${ic('check')} Approve</button>
        <button class="ck-btn ghost sm ckb-preject" data-name="${esc(name)}">Reject</button>
        <span style="flex:1"></span>
        <button class="ck-btn ghost sm ckb-deep" data-type="proposal" data-id="${esc(name)}">${ic('brain')} Deep review</button>
      </div>
      ${renderDeep(dk)}
    </div>` : ''}
  </div>`;
}

function renderQuestion(q) {
  const id = q.id;
  const dk = deepKey('question', id);
  const draft = B.answerDraft[id] || '';
  return `<div class="ckb-q" data-qid="${esc(id)}">
    <div class="ckb-q-head">
      ${q.agent ? `<span class="ck-run-prof">${esc(q.agent)}</span>` : ''}
      <span class="ckb-q-text">${esc(q.question || '(no text)')}</span>
    </div>
    <textarea class="ckb-answer" data-qid="${esc(id)}" rows="2" placeholder="Answer to resume the agent…">${esc(draft)}</textarea>
    <div class="ckb-card-actions">
      <button class="ck-btn primary sm ckb-qanswer" data-qid="${esc(id)}">Answer &amp; resume</button>
      <span style="flex:1"></span>
      <button class="ck-btn ghost sm ckb-deep" data-type="question" data-id="${esc(id)}">${ic('brain')} Deep review</button>
    </div>
    ${renderDeep(dk)}
  </div>`;
}

function renderDeep(dk) {
  const d = B.deep[dk];
  if (!d) return '';
  if (d.state === 'loading') {
    return '<div class="ckb-deep-pane"><span class="ck-spin"></span> Opus is reading the full context…</div>';
  }
  if (d.state === 'error') {
    return `<div class="ckb-deep-pane error"><strong>Deep review failed.</strong> ${esc(d.error || '')}</div>`;
  }
  const plan = d.plan ? `<h5 class="ckb-deep-h">Plan</h5><div class="aios-md">${mdToHtml(d.plan)}</div>` : '';
  return `<div class="ckb-deep-pane">
    <div class="ckb-deep-badge">${ic('brain')} Opus review</div>
    <div class="aios-md">${mdToHtml(d.recommendation || '_(no recommendation)_')}</div>
    ${plan}</div>`;
}

// ── bindings ──────────────────────────────────────────────────────────────────
function rerender() {
  const el = document.querySelector('#aios-cockpit-modal #ck-board');
  if (el) renderBoard(el);
}

function bindBoard(el) {
  const f = el.querySelector('#ckb-filter');
  if (f) f.addEventListener('input', (e) => {
    B.filter = e.target.value;
    // re-render only the kanban so the input keeps focus
    const k = el.querySelector('.ck-kanban');
    if (k) { k.innerHTML = COLS.map(renderColumn).join(''); bindCards(el); }
  });
  el.querySelector('#ckb-assignee')?.addEventListener('change', (e) => { B.fAssignee = e.target.value; rerender(); });
  el.querySelector('#ckb-createdby')?.addEventListener('change', (e) => { B.fCreatedBy = e.target.value; rerender(); });
  el.querySelector('#ckb-new')?.addEventListener('click', () => { B.showNewIssue = !B.showNewIssue; renderNewForm(el); });
  renderNewForm(el);
  bindCards(el);
  bindProposals(el);
  bindQuestions(el);
  bindDeep(el);
}

function bindCards(el) {
  el.querySelectorAll('.ckb-card-head').forEach((h) =>
    h.addEventListener('click', () => toggleCard(h.dataset.toggle)));
  el.querySelectorAll('.ckb-status').forEach((s) =>
    s.addEventListener('change', (e) => { e.stopPropagation(); moveIssue(s.dataset.id, e.target.value); }));
  el.querySelectorAll('.ckb-status').forEach((s) => s.addEventListener('click', (e) => e.stopPropagation()));
  el.querySelectorAll('.ckb-merge').forEach((b) =>
    b.addEventListener('click', (e) => { e.stopPropagation(); mergeIssue(b.dataset.id); }));
  // re-bind deep buttons inside cards (cards re-render independently)
  bindDeep(el);
}

function bindProposals(el) {
  el.querySelectorAll('.ckb-prop-head').forEach((h) =>
    h.addEventListener('click', () => toggleProposal(h.dataset.ptoggle)));
  el.querySelectorAll('.ckb-papprove').forEach((b) =>
    b.addEventListener('click', (e) => { e.stopPropagation(); actProposal(b.dataset.name, 'approve'); }));
  el.querySelectorAll('.ckb-preject').forEach((b) =>
    b.addEventListener('click', (e) => { e.stopPropagation(); actProposal(b.dataset.name, 'reject'); }));
}

function bindQuestions(el) {
  el.querySelectorAll('.ckb-answer').forEach((t) =>
    t.addEventListener('input', (e) => { B.answerDraft[t.dataset.qid] = e.target.value; }));
  el.querySelectorAll('.ckb-qanswer').forEach((b) =>
    b.addEventListener('click', () => answerQuestion(b.dataset.qid)));
}

function bindDeep(el) {
  el.querySelectorAll('.ckb-deep').forEach((b) => {
    if (b._bound) return; b._bound = true;
    b.addEventListener('click', (e) => { e.stopPropagation(); runDeep(b.dataset.type, b.dataset.id); });
  });
}

function renderNewForm(el) {
  const slot = el.querySelector('#ckb-newform');
  if (!slot) return;
  if (!B.showNewIssue) { slot.innerHTML = ''; return; }
  const n = B.newIssue;
  slot.innerHTML = `<div class="ckb-newform">
    <input id="ni-title" placeholder="Issue title…" value="${esc(n.title)}">
    <input id="ni-assignee" placeholder="assignee (specialist)" value="${esc(n.assignee)}">
    <input id="ni-priority" type="number" min="1" max="9" value="${esc(n.priority)}" title="priority 1-9">
    <select id="ni-status">${COLS.map((c) => `<option value="${c.key}" ${c.key === n.status ? 'selected' : ''}>${c.label}</option>`).join('')}</select>
    <button id="ni-create" class="ck-btn primary sm">Create</button>
    <button id="ni-cancel" class="ck-btn ghost sm">Cancel</button>
    <span id="ni-msg" class="ck-muted"></span>
  </div>`;
  slot.querySelector('#ni-title').addEventListener('input', (e) => { n.title = e.target.value; });
  slot.querySelector('#ni-assignee').addEventListener('input', (e) => { n.assignee = e.target.value; });
  slot.querySelector('#ni-priority').addEventListener('input', (e) => { n.priority = e.target.value; });
  slot.querySelector('#ni-status').addEventListener('change', (e) => { n.status = e.target.value; });
  slot.querySelector('#ni-cancel').addEventListener('click', () => { B.showNewIssue = false; renderNewForm(el); });
  slot.querySelector('#ni-create').addEventListener('click', () => createIssue(el));
}

// ── actions ───────────────────────────────────────────────────────────────────
async function toggleCard(id) {
  if (B.expanded.has(id)) { B.expanded.delete(id); rerender(); return; }
  B.expanded.add(id);
  if (!B.detail[id]) {
    B.detail[id] = 'loading'; rerender();
    const d = await aiosGet(`/issues/${encodeURIComponent(id)}`);
    B.detail[id] = (d && !d.error) ? d : { runs: [] };
  }
  rerender();
}

async function moveIssue(id, status) {
  const issue = B.issues.find((i) => i.id === id) || B.cancelled.find((i) => i.id === id);
  if (!issue || issue.status === status) return;
  const prev = issue.status;
  issue.status = status;                 // optimistic
  notifyChange();
  rerender();
  const res = await aiosPatch(`/issues/${encodeURIComponent(id)}`, { status });
  if (!res || res.error || res.ok === false) {
    issue.status = prev;                 // rollback
    notifyChange();
    rerender();
    window.alert(`Move failed: ${(res && (res.error || JSON.stringify(res))) || 'unknown'}`);
  } else {
    await loadBoard();
    notifyChange();
    rerender();
  }
}

async function mergeIssue(id) {
  if (!window.confirm(`Squash-merge the PR for "${id}" and mark it done?`)) return;
  const res = await aiosPost(`/issues/${encodeURIComponent(id)}/merge`, {});
  if (!res || res.error || res.ok === false) {
    window.alert(`Merge failed: ${(res && (res.error || JSON.stringify(res))) || 'unknown'}`);
    return;
  }
  await loadBoard();
  notifyChange();
  rerender();
}

async function createIssue(el) {
  const n = B.newIssue;
  const msg = el.querySelector('#ni-msg');
  if (!n.title.trim()) { if (msg) msg.textContent = 'title required'; return; }
  if (msg) msg.textContent = 'creating…';
  const res = await aiosPost('/issues', {
    title: n.title.trim(), assignee: n.assignee.trim() || null,
    priority: Number(n.priority) || 5, status: n.status,
  });
  if (res && res.ok) {
    B.newIssue = { title: '', assignee: '', priority: 5, status: 'backlog', project_dir: '' };
    B.showNewIssue = false;
    await loadBoard();
    notifyChange();
    rerender();
  } else if (msg) {
    msg.textContent = `failed: ${(res && (res.error || JSON.stringify(res))) || 'unknown'}`;
  }
}

async function toggleProposal(name) {
  if (B.propExpanded.has(name)) { B.propExpanded.delete(name); rerender(); return; }
  B.propExpanded.add(name);
  if (!B.propDetail[name]) {
    rerender();
    const d = await aiosGet(`/proposals/${encodeURIComponent(name)}`);
    B.propDetail[name] = (d && d.content) || '_Could not load this proposal._';
  }
  rerender();
}

async function actProposal(name, action) {
  const verb = action === 'approve' ? 'Approve' : 'Reject';
  if (!window.confirm(`${verb} proposal "${name}"?`)) return;
  const res = await aiosPost(`/proposals/${encodeURIComponent(name)}/${action}`, {});
  if (res && res.error) { window.alert(`Failed: ${res.error}`); return; }
  B.propExpanded.delete(name);
  await loadBoard();
  notifyChange();
  rerender();
}

async function answerQuestion(qid) {
  const text = (B.answerDraft[qid] || '').trim();
  if (!text) { window.alert('Write an answer first.'); return; }
  const res = await aiosPost(`/questions/${encodeURIComponent(qid)}/answer`, { answer: text });
  if (!res || res.error || res.ok === false) {
    window.alert(`Answer failed: ${(res && (res.error || JSON.stringify(res))) || 'unknown'}`);
    return;
  }
  delete B.answerDraft[qid];
  await loadBoard();
  notifyChange();
  rerender();
}

async function runDeep(type, id) {
  const dk = deepKey(type, id);
  if (B.deep[dk] && B.deep[dk].state === 'loading') return;
  B.deep[dk] = { state: 'loading' };
  rerender();
  const res = await aiosPost('/review/deep', { target_type: type, target_id: id });
  if (!res || res.error || res.ok === false) {
    B.deep[dk] = { state: 'error', error: (res && (res.error || JSON.stringify(res))) || 'unknown' };
  } else {
    B.deep[dk] = { state: 'done', recommendation: res.recommendation || '', plan: res.plan || '' };
  }
  rerender();
}

export default { loadBoard, renderBoard, setOnChange };
