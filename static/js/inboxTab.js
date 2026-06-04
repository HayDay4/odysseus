/**
 * inboxTab.js — the Workshop cockpit's "Inbox" tab (Phase 2 T2).
 *
 * The governance / approvals surface. Consumes the unified ranked feed at
 * GET /api/aios/inbox ({items:[{kind,id,title,subtitle,decision?,age_sec,
 * actions:[...],ref,advisory?}], counts, actionable_total}) and renders each item
 * as an actionable card. Every action maps to an already-proxied panel endpoint,
 * dispatched by kind:
 *   agent_question   → answer        (POST /questions/{id}/answer)
 *   task_proposal    → approve/reject (POST /task-proposals/{id}/…)  — mints issues
 *   routine_approval → approve/reject (POST /routine-runs/{id}/…)
 *   awaiting_input   → approve        (POST /awaiting/{ns}/{rid}/approve)
 *   reflection       → promote/discard(POST /reflections/{promote,discard} {slug})
 *   skill_proposal   → promote/discard(POST /skill-proposals/{name}/…)
 *   dream_proposal   → approve/reject (POST /proposals/{name}/…)      — Hermes
 *   merge_ready      → merge          (POST /issues/{id}/merge)
 *   manager_digest   → informational (no actions)
 *
 * Mirrors board.js discipline: all transient UI state lives in the module (I), so
 * the 5s poll re-render never clobbers a half-typed answer. workshop.js owns the
 * tab + re-invokes renderInbox() on the poll tick while the Inbox tab is active.
 */
import { aiosGet, aiosPost, esc } from './aiosShell.js';
import { ic } from './icons.js';
import { styledConfirm, styledAlert } from './ui.js';

const I = {
  loaded: false,
  items: [],
  counts: {},
  actionable: 0,
  answerDraft: {},   // question id -> textarea value (kept across re-renders)
  busy: new Set(),   // item ids mid-action (disable buttons)
  onChange: null,    // workshop callback (refresh Decisions strip / board)
};

export function setOnChange(fn) { I.onChange = fn; }

const KIND_LABEL = {
  agent_question: 'Question',
  task_proposal: 'Manager proposal',
  routine_approval: 'Routine firing',
  awaiting_input: 'Run blocked',
  reflection: 'Reflection',
  skill_proposal: 'Skill proposal',
  dream_proposal: 'Advisory',
  merge_ready: 'Merge ready',
  manager_digest: 'Digest',
};

const ACTION_LABEL = {
  answer: 'Answer & resume', approve: 'Approve', reject: 'Reject',
  promote: 'Promote', discard: 'Discard', merge: 'Merge',
};

function fmtAge(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

export async function loadInbox() {
  const d = await aiosGet('/inbox');
  I.items = (d && d.items) || [];
  I.counts = (d && d.counts) || {};
  I.actionable = (d && d.actionable_total) || 0;
  I.loaded = true;
  return I.actionable;
}

function rerender() {
  const el = document.querySelector('#aios-cockpit-modal #ck-inbox');
  if (el) renderInbox(el);
}

export function renderInbox(el) {
  if (!el) return;
  if (!I.loaded) {
    el.innerHTML = '<p class="ck-muted" style="padding:24px;">Loading inbox…</p>';
    loadInbox().then(() => renderInbox(el));
    return;
  }
  if (!I.items.length) {
    el.innerHTML = `<div class="ck-inbox-head">
        <h4 class="ckb-rail-h">Inbox <span class="ckb-rail-n">0</span>
          <span class="ckb-rail-sub">Decisions &amp; approvals</span></h4></div>
      <div class="ck-inbox-empty">${ic('check')}<span>Nothing needs you right now.</span></div>`;
    return;
  }
  el.innerHTML = `
    <div class="ck-inbox-head">
      <h4 class="ckb-rail-h">Inbox <span class="ckb-rail-n">${I.actionable}</span>
        <span class="ckb-rail-sub">${I.items.length} item${I.items.length !== 1 ? 's' : ''} · decisions &amp; approvals</span></h4>
    </div>
    <div class="ck-inbox-list">${I.items.map(renderItem).join('')}</div>`;
  bindInbox(el);
}

function renderItem(it) {
  const kind = it.kind || 'item';
  const actions = Array.isArray(it.actions) ? it.actions : [];
  const busy = I.busy.has(it.id);
  const adv = it.advisory && (it.advisory.summary || it.advisory.text);
  const isQuestion = kind === 'agent_question' && actions.includes('answer');
  const answerBox = isQuestion
    ? `<textarea class="ckb-answer ck-inbox-answer" data-qid="${esc(it.id)}" rows="2"
         placeholder="Answer to resume the agent…">${esc(I.answerDraft[it.id] || '')}</textarea>`
    : '';
  const btns = actions.map((a) => {
    const danger = (a === 'reject' || a === 'discard');
    const primary = (a === 'approve' || a === 'promote' || a === 'merge' || a === 'answer');
    const cls = primary ? 'primary' : (danger ? 'ghost' : 'ghost');
    const icon = a === 'merge' ? ic('merge') : (primary && a !== 'answer') ? ic('check') : '';
    return `<button class="ck-btn ${cls} sm ck-inbox-act" data-id="${esc(it.id)}" data-kind="${esc(kind)}"
      data-action="${esc(a)}" ${busy ? 'disabled' : ''}>${icon}${ACTION_LABEL[a] || a}</button>`;
  }).join('');
  return `<div class="ck-inbox-card" data-id="${esc(it.id)}">
    <div class="ck-inbox-card-top">
      <span class="ck-run-prof ck-inbox-kind">${esc(KIND_LABEL[kind] || kind)}</span>
      <span class="ck-inbox-title">${esc(it.title || it.id)}</span>
      <span style="flex:1"></span>
      <span class="ck-muted ck-inbox-age">${fmtAge(it.age_sec)}</span>
    </div>
    ${it.subtitle ? `<div class="ck-inbox-sub">${esc(it.subtitle)}</div>` : ''}
    ${it.decision ? `<div class="ck-inbox-decision">${esc(it.decision)}</div>` : ''}
    ${adv ? `<div class="ck-inbox-adv">${esc(String(adv).slice(0, 400))}</div>` : ''}
    ${answerBox}
    ${btns ? `<div class="ck-inbox-actions">${btns}</div>` : ''}
  </div>`;
}

function bindInbox(el) {
  el.querySelectorAll('.ck-inbox-answer').forEach((t) =>
    t.addEventListener('input', (e) => { I.answerDraft[t.dataset.qid] = e.target.value; }));
  el.querySelectorAll('.ck-inbox-act').forEach((b) =>
    b.addEventListener('click', () => act(b.dataset.kind, b.dataset.id, b.dataset.action)));
}

// kind+action → {path, body, confirm?}. Returns null for unsupported combos.
function resolve(kind, id, action) {
  switch (kind) {
    case 'agent_question':
      if (action === 'answer') {
        const text = (I.answerDraft[id] || '').trim();
        if (!text) return { error: 'Write an answer first.' };
        return { path: `/questions/${encodeURIComponent(id)}/answer`, body: { answer: text } };
      }
      break;
    case 'task_proposal':
      return { path: `/task-proposals/${encodeURIComponent(id)}/${action}`, body: {},
        confirm: action === 'approve' ? 'Approve this proposal? It mints issues and assigns specialists.' : 'Reject this proposal?' };
    case 'routine_approval':
      return { path: `/routine-runs/${encodeURIComponent(id)}/${action}`, body: {},
        confirm: action === 'approve' ? 'Approve this scheduled firing?' : 'Reject this firing?' };
    case 'awaiting_input': {
      const [ns, rid] = String(id).split('/');
      if (!ns || !rid) return { error: 'malformed awaiting id' };
      return { path: `/awaiting/${encodeURIComponent(ns)}/${encodeURIComponent(rid)}/approve`, body: {},
        confirm: 'Approve and unblock this run?' };
    }
    case 'reflection':
      return { path: `/reflections/${action}`, body: { slug: id },
        confirm: action === 'promote' ? 'Promote this reflection into long-term memory?' : 'Discard this reflection?' };
    case 'skill_proposal':
      return { path: `/skill-proposals/${encodeURIComponent(id)}/${action}`, body: {},
        confirm: action === 'promote' ? 'Promote this skill into ~/.claude/skills?' : 'Discard this staged skill?' };
    case 'dream_proposal':
      return { path: `/proposals/${encodeURIComponent(id)}/${action}`, body: {},
        confirm: action === 'approve' ? 'Approve this advisory proposal?' : 'Reject this advisory?' };
    case 'merge_ready':
      return { path: `/issues/${encodeURIComponent(id)}/merge`, body: {},
        confirm: 'Squash-merge the PR and mark the issue done?' };
  }
  return null;
}

async function act(kind, id, action) {
  if (I.busy.has(id)) return;
  const r = resolve(kind, id, action);
  if (!r) { await styledAlert(`Action "${action}" not supported for ${kind}.`, { title: 'Unsupported' }); return; }
  if (r.error) { await styledAlert(r.error, { title: 'Cannot act' }); return; }
  if (r.confirm) {
    const danger = (action === 'reject' || action === 'discard');
    if (!await styledConfirm(r.confirm, { confirmText: ACTION_LABEL[action] || action, danger })) return;
  }
  I.busy.add(id); rerender();
  const res = await aiosPost(r.path, r.body);
  I.busy.delete(id);
  if (!res || res.error || res.ok === false) {
    await styledAlert(`Failed: ${(res && (res.error || res.detail || JSON.stringify(res))) || 'unknown'}`,
      { title: `${ACTION_LABEL[action] || action} failed`, danger: true });
    rerender();
    return;
  }
  if (action === 'answer') delete I.answerDraft[id];
  if (kind === 'task_proposal' && action === 'approve' && Array.isArray(res.issues) && res.issues.length) {
    await styledAlert(`Minted ${res.issues.length} issue${res.issues.length !== 1 ? 's' : ''}.`, { title: 'Proposal approved' });
  }
  await loadInbox();
  if (I.onChange) I.onChange();
  rerender();
}

export default { loadInbox, renderInbox, setOnChange };
