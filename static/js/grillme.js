/**
 * grillme.js — the /grill-me front door (GRILLME_PROMPT.md).
 *
 * Local-model intake → handoff brief → egress consent → Opus plan-mode review →
 * cockpit spawn. This orchestrator owns the JS half:
 *   1. startIntake()    — activate the grill_me preset + (Phase 2) inject a compact
 *                         existing-work summary so the model won't re-spec done work.
 *   2. produceHandoff() — read the model's last reply, POST it to
 *                         /api/grillme/handoff (parse + scrub + stage at the egress
 *                         gate), show the Approve-egress modal, poll the decision,
 *                         and on approve hand the scrubbed brief to the cockpit.
 *
 * The ONLY thing that egresses is the gate-approved scrubbed brief — never the raw
 * conversation. The egress modal records the decision but fires no callback, so we
 * poll GET /api/egress/decision for our own request_id.
 */
import sessionModule from './sessions.js';
import uiModule from './ui.js';
import presetsModule from './presets.js';
import egressConsentModule from './egressConsent.js';
import workshopModule from './workshop.js';

const GRILL_PRESET = 'grill_me';
let API = window.location.origin;

export function initGrillme(apiBase) { if (apiBase) API = apiBase; }

async function _getJSON(path) {
  try {
    const r = await fetch(`${API}${path}`, { credentials: 'same-origin' });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// ── 1. start the interrogation ──────────────────────────────────────────────
export async function startIntake(projectSlug) {
  const slug = (projectSlug || '').trim();
  if (presetsModule.setActivePreset) presetsModule.setActivePreset(GRILL_PRESET);

  const preamble = slug ? await _existingWorkPreamble(slug) : '';
  const input = uiModule.el && uiModule.el('message');
  if (input) {
    input.value = slug
      ? `I want to start a new brief for project "${slug}". Interrogate me.${preamble ? '\n\n' + preamble : ''}`
      : 'I want to start a new brief. Interrogate me one question at a time.';
    input.focus();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return preamble;
}

// Phase 2 — compact existing-work summary from the bridge (active runs + kanban).
async function _existingWorkPreamble(slug) {
  const seg = encodeURIComponent(slug);
  const [runs, kanban] = await Promise.all([
    _getJSON(`/api/aios/projects/${seg}/active-runs`),
    _getJSON(`/api/aios/projects/${seg}/kanban`),
  ]);
  const parts = [];
  const active = _activeRunTasks(runs);
  if (active.length) parts.push(`In flight now: ${active.slice(0, 6).join('; ')}`);
  const issues = _kanbanTitles(kanban);
  if (issues.length) parts.push(`Open issues already tracked: ${issues.slice(0, 8).join('; ')}`);
  if (!parts.length) return '';
  return `(Existing work — do NOT re-spec these. ${parts.join(' · ')}.)`;
}

function _activeRunTasks(runs) {
  const arr = (runs && (runs.active || runs.runs)) || (Array.isArray(runs) ? runs : []);
  if (!Array.isArray(arr)) return [];
  return arr.map((r) => (r && (r.task || r.short_id || r.id)) || '').filter(Boolean);
}

// kanban shape varies; handle the common ones defensively.
function _kanbanTitles(k) {
  if (!k) return [];
  const out = [];
  const push = (c) => { const t = c && (c.title || c.name || c.task); if (t) out.push(t); };
  if (Array.isArray(k)) k.forEach(push);
  else if (Array.isArray(k.issues)) k.issues.forEach(push);
  else if (Array.isArray(k.cards)) k.cards.forEach(push);
  else if (Array.isArray(k.columns)) k.columns.forEach((col) => (col.cards || col.items || []).forEach(push));
  else if (k.open && Array.isArray(k.open)) k.open.forEach(push);
  return out;
}

// ── 2. produce the handoff ──────────────────────────────────────────────────
export async function produceHandoff() {
  const sid = sessionModule.getCurrentSessionId && sessionModule.getCurrentSessionId();
  if (!sid) { _toast('No active chat session.'); return; }

  const text = await _lastAssistantText(sid);
  if (!text) { _toast('No assistant reply yet — let the intake model answer first.'); return; }

  const res = await fetch(`${API}/api/grillme/handoff`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ text }),
  }).then((r) => r.json()).catch(() => null);

  if (!res || !res.ok) {
    _toast((res && res.detail) || 'No handoff brief found in the last reply. Ask the model to PRODUCE HANDOFF.');
    return;
  }

  // Show diego the EXACT scrubbed brief; block until a decision on OUR request_id.
  egressConsentModule.openEgressConsent();
  const approved = await _awaitDecision(res.request_id);
  egressConsentModule.closeEgressConsent();
  if (!approved) { _toast('Egress not approved — brief was not sent to the workforce.'); return; }

  // Hand the scrubbed brief to the cockpit (Opus plan-mode review happens there).
  await workshopModule.openWorkshopWithBrief({ parsed: res.parsed, scrubbed: res.scrubbed });
}

async function _lastAssistantText(sid) {
  const d = await _getJSON(`/api/history/${encodeURIComponent(sid)}`);
  const h = (d && d.history) || [];
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i] && h[i].role === 'assistant' && String(h[i].content || '').trim()) return h[i].content;
  }
  return '';
}

async function _awaitDecision(requestId, timeoutMs = 300000) {
  const start = Date.now();
  const check = async () => {
    const d = await _getJSON(`/api/egress/decision?request_id=${encodeURIComponent(requestId)}`);
    if (d && d.matches && d.decision) return { done: true, approved: !!d.decision.approved };
    return { done: false };
  };
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1500));
    const c = await check();
    if (c.done) return c.approved;
    if (!egressConsentModule.isEgressConsentOpen()) {
      const last = await check();   // user closed the modal — one final read
      return last.done ? last.approved : false;
    }
  }
  return false;   // timed out
}

function _toast(msg) {
  if (uiModule.showToast) uiModule.showToast(msg);
  else if (uiModule.showError) uiModule.showError(msg);
  else console.log('[grill-me]', msg);   // eslint-disable-line no-console
}

export default { initGrillme, startIntake, produceHandoff };
