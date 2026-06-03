/**
 * brief.js — native Brief / spawn form (MIGRATION_PLAN §7).
 * POST /api/aios/brief/spawn {slug, prompt, profile?} → {ok, run_id, ...}.
 * Mirrors the panel POST /api/brief/spawn shape (B6).
 */
import { createAiosModal, aiosPost, esc } from './aiosShell.js';

async function _submit() {
  const slug = document.getElementById('brief-slug')?.value.trim();
  const prompt = document.getElementById('brief-prompt')?.value.trim();
  const profile = document.getElementById('brief-profile')?.value.trim();
  const out = document.getElementById('brief-result');
  if (!slug || !prompt) { if (out) out.textContent = 'slug and prompt are required.'; return; }
  if (out) out.textContent = 'Spawning…';
  const body = { slug, prompt };
  if (profile) body.profile = profile;
  const res = await aiosPost('/brief/spawn', body);
  if (!out) return;
  if (res && res.ok) {
    out.innerHTML = `Spawned. run_id <code>${esc(res.run_id)}</code> (ns ${esc(res.ns || '')}, profile ${esc(res.profile || '')}).`;
  } else {
    out.textContent = `Failed: ${(res && (res.error || JSON.stringify(res))) || 'unknown error'}`;
  }
}

async function render(body) {
  body.innerHTML = `
    <label style="font-size:12px;opacity:0.8;">Project slug
      <input id="brief-slug" type="text" placeholder="e.g. growly" style="width:100%;margin-top:3px;"></label>
    <label style="font-size:12px;opacity:0.8;">Profile (optional)
      <input id="brief-profile" type="text" placeholder="e.g. web-developer" style="width:100%;margin-top:3px;"></label>
    <label style="font-size:12px;opacity:0.8;">Task prompt
      <textarea id="brief-prompt" rows="6" placeholder="What should the agent do?" style="width:100%;margin-top:3px;"></textarea></label>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:6px;">
      <button id="brief-submit" class="btn" style="background:var(--accent, var(--green));color:var(--panel);">Spawn run</button>
    </div>
    <div id="brief-result" style="font-size:12px;opacity:0.85;min-height:18px;"></div>`;
  body.querySelector('#brief-submit').addEventListener('click', _submit);
}

const modal = createAiosModal({ id: 'aios-brief-modal', title: 'Brief / Spawn', render });
export const openBrief = modal.open;
export const closeBrief = modal.close;
export const isBriefOpen = modal.isOpen;
export default { openBrief, closeBrief, isBriefOpen };
